#!/usr/bin/env python3
"""Synchronize an Onshape multilevel BOM into Baserow.

Engineering-owned fields are updated when a manufacturing-root revision changes.
Manufacturing status, machinist, location, QC, and disposition are intentionally
untouched. Released routing, powder-coat color, and their work queues are
sync-managed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse

import requests


ASSEMBLY_NAME_RE = re.compile(r"^A-[A-Za-z0-9-]+$")
BATCH_SIZE = 100
ONSHAPE_API_VERSION = "v16"
ASSEMBLY_ELEMENT_TYPE = 1
DRAWING_ELEMENT_TYPE = 2
CAD_EXPORT_CACHE_VERSION = "v2"
DRAWING_PDF_FIELD = "Drawing PDF"
DRAWING_PDF_KEY_FIELD = "Drawing PDF Export Key"
STEP_FILE_FIELD = "STEP File"
STEP_KEY_FIELD = "STEP Export Key"
EXPORT_POLL_SECONDS = (2, 4, 8, 10)
STEP_EXPORT_METHODS = frozenset(
    method.casefold()
    for method in (
        "Haas CNC",
        "Shop Sabre CNC",
        "Bambu 3D Printer",
        "Markforged 3D Printer",
        "FormLabs SLA",
        "FormLabs SLS",
    )
)
OPERATION_PROPERTY_NAMES = (
    "Manufacturing Method",
    "Manufacturing Method OP2",
    "Manufacturing Method OP3",
    "Manufacturing Method OP4",
)
POWDER_COAT_PROPERTY_NAME = "Powder Coat Color"
HYDRATED_PART_PROPERTY_NAMES = (
    *OPERATION_PROPERTY_NAMES,
    POWDER_COAT_PROPERTY_NAME,
)
SYNC_SCHEMA_VERSION = "incremental-bulk-onshape-v2"
ONSHAPE_CALL_COUNTS: Counter[str] = Counter()
PRODUCTION_REQUIREMENT_MANAGED_FIELDS = (
    "Part",
    "Assembly",
    "Source Root",
    "Source Assembly Revision",
    "Required Part Revision",
    "Configuration",
    "Required Quantity",
    "BOM Positions",
    "Onshape Source",
    "Source Document",
    "Machine OP1",
    "Machine OP2",
    "Machine OP3",
    "Machine OP4",
    "Finishing",
    "Active in BOM",
)
BASEROW_MACHINE_NAMES = (
    "Haas CNC",
    "Shop Sabre CNC",
    "Milling Machine",
    "Lathe",
    "Markforged 3D Printer",
    "Bambu 3D Printer",
    "Bandsaw",
    "Sander",
    "Drill Press",
    "COTS",
    "FormLabs SLA",
    "FormLabs SLS",
    "Countersinking",
    "Threaded Insert",
    "Tapping",
    "Guided Drilling",
    "Bending",
    "Bridgeport",
)
MACHINE_NAME_ALIASES = {
    re.sub(r"[^a-z0-9]+", "", name.casefold()): name
    for name in BASEROW_MACHINE_NAMES
}
MACHINE_NAME_ALIASES.update(
    {
        "haas": "Haas CNC",
        "shopsabre": "Shop Sabre CNC",
    }
)


@dataclass(frozen=True)
class OnshapeTarget:
    base_url: str
    did: str
    wvm_type: str
    wvm_id: str
    eid: str
    configuration: str = "default"


@dataclass(frozen=True)
class OnshapeDocumentReference:
    base_url: str
    did: str
    wvm_type: str
    wvm_id: str


@dataclass(frozen=True)
class PartExportSource:
    base_url: str
    did: str
    wv: str
    wvid: str
    eid: str
    part_id: str
    configuration: str


@dataclass(frozen=True)
class FileExport:
    part_number: str
    field_name: str
    key_field_name: str
    source_key: str
    filename: str
    content_type: str
    endpoint: str
    request_body: dict
    source_document_id: str


@dataclass(frozen=True)
class ReleasedAssembly:
    document_id: str
    element_id: str
    version_id: str
    revision: str
    part_number: str
    name: str
    configuration: str
    release_id: str
    release_name: str
    version_name: str
    created_at: str
    is_obsolete: bool
    view_ref: str

    def bom_target(self, base_url: str) -> OnshapeTarget:
        return OnshapeTarget(
            base_url=base_url,
            did=self.document_id,
            wvm_type="v",
            wvm_id=self.version_id,
            eid=self.element_id,
            configuration=self.configuration,
        )

    def as_dict(self) -> dict:
        return {
            "document_id": self.document_id,
            "element_id": self.element_id,
            "version_id": self.version_id,
            "revision": self.revision,
            "part_number": self.part_number,
            "name": self.name,
            "configuration": self.configuration,
            "release_id": self.release_id,
            "release_name": self.release_name,
            "version_name": self.version_name,
            "created_at": self.created_at,
            "is_obsolete": self.is_obsolete,
            "view_ref": self.view_ref,
        }


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_onshape_doc_url(doc_url: str) -> OnshapeTarget:
    parsed = urlparse(doc_url.strip())
    match = re.search(
        r"/documents/([a-fA-F0-9]+)/([wvm])/([a-fA-F0-9]+)/e/([a-fA-F0-9]+)",
        parsed.path,
    )
    if not parsed.scheme or not parsed.netloc or not match:
        raise ValueError("ONSHAPE_DOC_URL must be a full Onshape assembly-tab URL")
    did, wvm_type, wvm_id, eid = match.groups()
    configuration = parse_qs(parsed.query, keep_blank_values=True).get(
        "configuration", ["default"]
    )[0]
    return OnshapeTarget(
        base_url=f"{parsed.scheme}://{parsed.netloc}",
        did=did,
        wvm_type=wvm_type,
        wvm_id=wvm_id,
        eid=eid,
        configuration=configuration or "default",
    )


def parse_onshape_doc_urls(doc_urls: str) -> list[OnshapeTarget]:
    """Parse a comma- or newline-separated list of Onshape assembly URLs."""
    values = [
        value.strip()
        for value in re.split(r"[\r\n,]+", str(doc_urls or ""))
        if value.strip()
    ]
    if not values:
        raise ValueError("ONSHAPE_SUBASSEMBLY_URLS must contain at least one URL")
    targets = []
    for value in values:
        try:
            targets.append(parse_onshape_doc_url(value))
        except ValueError as exc:
            raise ValueError(
                f"Invalid URL in ONSHAPE_SUBASSEMBLY_URLS: {value}"
            ) from exc
    return targets


def onshape_target_url(target: OnshapeTarget) -> str:
    base = (
        f"{target.base_url.rstrip('/')}/documents/{target.did}/"
        f"{target.wvm_type}/{target.wvm_id}/e/{target.eid}"
    )
    if target.configuration == "default":
        return base
    return f"{base}?{urlencode({'configuration': target.configuration})}"


def onshape_headers(method: str, full_url: str) -> dict[str, str]:
    parsed = urlparse(full_url)
    date = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
    nonce = os.urandom(16).hex()
    content_type = "application/json"
    string_to_sign = (
        f"{method}\n{nonce}\n{date}\n{content_type}\n"
        f"{parsed.path}\n{parsed.query or ''}\n"
    ).lower()
    signature = hmac.new(
        require_env("ONSHAPE_SECRET_KEY").encode(),
        string_to_sign.encode(),
        hashlib.sha256,
    ).digest()
    encoded = base64.b64encode(signature).decode()
    return {
        "Authorization": f"On {require_env('ONSHAPE_ACCESS_KEY')}:HmacSHA256:{encoded}",
        "Date": date,
        "On-Nonce": nonce,
        "Content-Type": content_type,
        "Accept": "application/json",
    }


def onshape_call_category(method: str, url: str) -> str:
    """Return a stable, low-cardinality label for Onshape request telemetry."""
    path = urlparse(url).path.rstrip("/")
    query = parse_qs(urlparse(url).query)
    if re.search(r"/assemblies/d/[^/]+/[wvm]/[^/]+/e/[^/]+/bom$", path):
        return "bom"
    if re.search(r"/metadata/d/[^/]+/[wvm]/[^/]+/e/[^/]+/p$", path):
        return "part_metadata_bulk"
    if re.search(r"/metadata/d/[^/]+/[wvm]/[^/]+/e/[^/]+/p/[^/]+$", path):
        return "part_metadata_single"
    if "/metadata/" in path:
        return "element_metadata"
    if re.search(r"/revisions/d/[^/]+$", path):
        return "document_revisions"
    if path.endswith("/latest") and query.get("et") == [str(ASSEMBLY_ELEMENT_TYPE)]:
        return "assembly_revision"
    if path.endswith("/latest") and query.get("et") == [str(DRAWING_ELEMENT_TYPE)]:
        return "drawing_revision"
    if re.search(r"/documents/d/[^/]+/[wvm]/[^/]+/elements$", path):
        return "document_elements"
    if re.search(r"/documents/[^/]+$", path):
        return "document_metadata"
    if "/translations" in path:
        return "translation_status" if method == "GET" else "translation_create"
    if "/externaldata/" in path:
        return "translation_download"
    return "other"


def record_onshape_call(method: str, url: str) -> None:
    ONSHAPE_CALL_COUNTS[onshape_call_category(method, url)] += 1


def reset_onshape_call_counts() -> None:
    ONSHAPE_CALL_COUNTS.clear()


def onshape_call_summary() -> dict:
    return {
        "total": sum(ONSHAPE_CALL_COUNTS.values()),
        "by_category": dict(sorted(ONSHAPE_CALL_COUNTS.items())),
    }


def onshape_get_json(url: str) -> dict:
    record_onshape_call("GET", url)
    response = requests.get(url, headers=onshape_headers("GET", url), timeout=60)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"Unexpected Onshape response from {url}: expected an object")
    return payload


def onshape_get_optional_json(url: str) -> dict | None:
    """Return an Onshape JSON object, or None for a successful 204 response."""
    record_onshape_call("GET", url)
    response = requests.get(url, headers=onshape_headers("GET", url), timeout=60)
    response.raise_for_status()
    if response.status_code == 204:
        return None
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"Unexpected Onshape response from {url}: expected an object")
    return payload


def onshape_get_json_list(url: str) -> list:
    record_onshape_call("GET", url)
    response = requests.get(url, headers=onshape_headers("GET", url), timeout=60)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected Onshape response from {url}: expected an array")
    return payload


def onshape_post_json(url: str, body: dict) -> dict:
    record_onshape_call("POST", url)
    response = requests.post(
        url, headers=onshape_headers("POST", url), json=body, timeout=60
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"Unexpected Onshape response from {url}: expected an object")
    return payload


def onshape_download(url: str) -> bytes:
    record_onshape_call("GET", url)
    headers = onshape_headers("GET", url)
    headers["Accept"] = "application/octet-stream"
    response = requests.get(url, headers=headers, timeout=120)
    response.raise_for_status()
    return response.content


def normalized_configuration(value) -> str:
    configuration = str(value or "").strip()
    return configuration if configuration and configuration.lower() != "default" else "default"


def metadata_property(payload: dict, property_name: str) -> str:
    """Return a named Onshape metadata property value."""
    properties = payload.get("properties")
    if not isinstance(properties, list):
        raise RuntimeError("Unexpected Onshape element metadata: no properties array")
    wanted = property_name.casefold()
    for item in properties:
        if (
            isinstance(item, dict)
            and str(item.get("name") or "").strip().casefold() == wanted
        ):
            return str(item.get("value") or "").strip()
    return ""


def fetch_assembly_part_number(target: OnshapeTarget) -> str:
    """Resolve the tracked workspace assembly element to its part number."""
    endpoint = (
        f"{target.base_url}/api/{ONSHAPE_API_VERSION}/metadata/d/{target.did}/"
        f"{target.wvm_type}/{target.wvm_id}/e/{target.eid}"
    )
    params = {
        "includeComputedProperties": "true",
        "includeComputedAssemblyProperties": "true",
    }
    payload = onshape_get_json(f"{endpoint}?{urlencode(params)}")
    part_number = metadata_property(payload, "Part number")
    if not part_number:
        raise RuntimeError(
            "The assembly element in ONSHAPE_DOC_URL has no Part number metadata"
        )
    return part_number


def fetch_latest_assembly_revision(
    target: OnshapeTarget, part_number: str
) -> dict:
    """Fetch the latest assembly revision for a company-owned part number."""
    encoded_part_number = quote(part_number, safe="")
    endpoint = (
        f"{target.base_url}/api/{ONSHAPE_API_VERSION}/revisions/d/{target.did}/"
        f"p/{encoded_part_number}/latest"
    )
    return onshape_get_json(
        f"{endpoint}?{urlencode({'et': ASSEMBLY_ELEMENT_TYPE})}"
    )


def fetch_latest_discovered_assembly_revision(
    reference: OnshapeDocumentReference, part_number: str
) -> dict | None:
    """Fetch a discovered child assembly's latest release, allowing no release."""
    encoded_part_number = quote(part_number, safe="")
    endpoint = (
        f"{reference.base_url}/api/{ONSHAPE_API_VERSION}/revisions/d/"
        f"{reference.did}/p/{encoded_part_number}/latest"
    )
    return onshape_get_optional_json(
        f"{endpoint}?{urlencode({'et': ASSEMBLY_ELEMENT_TYPE})}"
    )


def fetch_latest_drawing_revision(
    reference: OnshapeDocumentReference, part_number: str
) -> dict | None:
    """Fetch the latest released drawing revision for a company-owned part number."""
    encoded_part_number = quote(part_number, safe="")
    endpoint = (
        f"{reference.base_url}/api/{ONSHAPE_API_VERSION}/revisions/d/{reference.did}/"
        f"p/{encoded_part_number}/latest"
    )
    return onshape_get_optional_json(
        f"{endpoint}?{urlencode({'et': DRAWING_ELEMENT_TYPE})}"
    )


def released_drawing_url(
    reference: OnshapeDocumentReference, part_number: str, latest: dict
) -> str:
    """Build an immutable URL from a drawing's own revision record."""
    if latest.get("elementType") not in (None, DRAWING_ELEMENT_TYPE):
        raise RuntimeError(
            f"Latest drawing revision for {part_number} is not a drawing"
        )
    returned_part_number = str(latest.get("partNumber") or "").strip()
    if (
        returned_part_number
        and normalized_part_number(returned_part_number)
        != normalized_part_number(part_number)
    ):
        raise RuntimeError(
            "Onshape latest drawing revision returned a different part number for "
            f"{part_number}"
        )

    required_ids = {
        "documentId": "document",
        "elementId": "element",
        "versionId": "immutable version",
    }
    resolved_ids = {
        field: str(latest.get(field) or "").strip() for field in required_ids
    }
    missing = [label for field, label in required_ids.items() if not resolved_ids[field]]
    if missing:
        raise RuntimeError(
            f"Latest released drawing revision for {part_number} has no "
            + ", ".join(missing)
            + " ID"
        )
    return (
        f"{reference.base_url}/documents/{resolved_ids['documentId']}/"
        f"v/{resolved_ids['versionId']}/e/{resolved_ids['elementId']}"
    )


def released_assembly_from_revision(latest: dict) -> ReleasedAssembly:
    """Build an immutable BOM source solely from the returned revision record."""
    if latest.get("elementType") not in (None, ASSEMBLY_ELEMENT_TYPE):
        raise RuntimeError("Latest revision for the tracked part number is not an assembly")

    required_ids = {
        "documentId": "document",
        "elementId": "element",
        "versionId": "immutable version",
    }
    resolved_ids = {
        field: str(latest.get(field) or "").strip() for field in required_ids
    }
    missing = [label for field, label in required_ids.items() if not resolved_ids[field]]
    if missing:
        raise RuntimeError(
            "Latest released assembly revision has no " + ", ".join(missing) + " ID"
        )

    return ReleasedAssembly(
        document_id=resolved_ids["documentId"],
        element_id=resolved_ids["elementId"],
        version_id=resolved_ids["versionId"],
        revision=str(latest.get("revision") or "").strip(),
        part_number=str(latest.get("partNumber") or "").strip(),
        name=str(latest.get("name") or "").strip(),
        configuration=normalized_configuration(latest.get("configuration")),
        release_id=str(latest.get("releaseId") or "").strip(),
        release_name=str(latest.get("releaseName") or "").strip(),
        version_name=str(latest.get("versionName") or "").strip(),
        created_at=str(
            latest.get("releaseCreatedDate") or latest.get("createdAt") or ""
        ).strip(),
        is_obsolete=bool(latest.get("isObsolete")),
        view_ref=str(latest.get("viewRef") or "").strip(),
    )


def resolve_latest_released_assembly(target: OnshapeTarget) -> ReleasedAssembly:
    if target.wvm_type != "w":
        raise ValueError("ONSHAPE_DOC_URL must point to the assembly in a workspace (Main)")
    part_number = fetch_assembly_part_number(target)
    latest = fetch_latest_assembly_revision(target, part_number)
    released = released_assembly_from_revision(latest)
    if released.part_number and released.part_number != part_number:
        raise RuntimeError(
            "Onshape latest-revision response returned a different part number"
        )
    return released


def normalize_bom_rows(headers: list[dict], rows: list[dict]) -> list[dict]:
    """Decode v16 BOM cells from header IDs into their property names."""
    property_names: dict[str, tuple[str, ...]] = {}
    for header in headers:
        if not isinstance(header, dict):
            continue
        header_id = str(
            header.get("id")
            or header.get("headerId")
            or header.get("propertyId")
            or ""
        ).strip()
        names = tuple(
            dict.fromkeys(
                name
                for name in (
                    str(header.get("propertyName") or "").strip(),
                    str(header.get("name") or "").strip(),
                )
                if name
            )
        )
        if header_id and names:
            property_names[header_id] = names

    normalized = []
    for original in rows:
        if not isinstance(original, dict):
            raise RuntimeError("Unexpected Onshape BOM response: row is not an object")
        row = dict(original)
        values = row.pop("headerIdToValue", None)
        if values is None:
            normalized.append(row)
            continue
        if not isinstance(values, dict):
            raise RuntimeError(
                "Unexpected Onshape BOM response: headerIdToValue is not an object"
            )
        if not property_names and values:
            raise RuntimeError(
                "Unexpected Onshape BOM response: rows use header IDs but no headers "
                "define property names"
            )
        for header_id, value in values.items():
            for property_name in property_names.get(str(header_id), ()):
                row[property_name] = value
        normalized.append(row)
    return normalized


def bom_rows_from_container(container: dict) -> list[dict] | None:
    """Return flat rows from either the v16 or legacy BOM container shape."""
    headers = container.get("headers")
    for key in ("rows", "items", "bomItems", "bomRows"):
        rows = container.get(key)
        if not isinstance(rows, list):
            continue
        if any(isinstance(row, dict) and "headerIdToValue" in row for row in rows):
            if not isinstance(headers, list):
                headers = []
            return normalize_bom_rows(headers, rows)
        return rows
    return None


def fetch_bom(
    target: OnshapeTarget, *, generate_if_absent: bool = False
) -> list[dict]:
    endpoint = (
        f"{target.base_url}/api/{ONSHAPE_API_VERSION}/assemblies/d/{target.did}/"
        f"{target.wvm_type}/{target.wvm_id}/e/{target.eid}/bom"
    )
    params = {
        "indented": "true",
        "multiLevel": "true",
        "generateIfAbsent": "true" if generate_if_absent else "false",
        "includeItemMicroversions": "false",
        "includeTopLevelAssemblyRow": "false",
        "thumbnail": "false",
        "configuration": target.configuration,
    }
    url = f"{endpoint}?{urlencode(params)}"
    payload = onshape_get_json(url)
    if isinstance(payload.get("bomTable"), dict):
        rows = bom_rows_from_container(payload["bomTable"])
        if rows is not None:
            return rows
    rows = bom_rows_from_container(payload)
    if rows is not None:
        return rows
    raise RuntimeError("Unexpected Onshape BOM response: no items array")


def indent_level(row: dict) -> int:
    value = row.get("indentLevel")
    source = row.get("itemSource")
    if value is None and isinstance(source, dict):
        value = source.get("indentLevel", 0)
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def assembly_number(row: dict) -> str:
    """Return the released assembly identity, preferring Part Number."""
    name = str(row.get("name") or "").strip()
    part_number = str(row.get("partNumber") or "").strip()
    if ASSEMBLY_NAME_RE.match(part_number):
        return part_number
    if ASSEMBLY_NAME_RE.match(name) and part_number.upper() in ("", "N/A"):
        return name
    return ""


def is_assembly_row(row: dict) -> bool:
    return bool(assembly_number(row))


def annotate_assemblies(
    items: list[dict], root_assembly_number: str = ""
) -> list[dict]:
    """Assign each BOM row to its nearest assembly, falling back to the root."""
    output = []
    stack: list[tuple[int, str]] = []
    for original in items:
        row = dict(original)
        level = indent_level(row)
        while stack and stack[-1][0] >= level:
            stack.pop()
        if is_assembly_row(row):
            stack.append((level, assembly_number(row)))
        row["assemblyNumber"] = (
            stack[-1][1] if stack else root_assembly_number
        )
        output.append(row)
    return output


def assembly_revisions(items: list[dict]) -> dict[str, str]:
    """Return assembly revisions captured by an immutable released BOM."""
    return {
        assembly_number(row): str(row.get("revision") or "").strip()
        for row in items
        if is_assembly_row(row)
    }


def material_name(value) -> str:
    if isinstance(value, dict):
        return str(value.get("displayName") or value.get("id") or "").strip()
    return str(value or "").strip()


def source_url_and_configuration(value) -> tuple[str, str]:
    if isinstance(value, dict):
        url = str(value.get("viewHref") or value.get("href") or "").strip()
        source_configuration = str(
            value.get("configuration") or value.get("fullConfiguration") or ""
        ).strip()
    else:
        url = str(value or "").strip()
        source_configuration = ""
    configuration = parse_qs(urlparse(url).query).get(
        "configuration", [source_configuration or "default"]
    )[0]
    return url, configuration or "default"


def item_source_document_id(value) -> str:
    """Return an item source's document ID, including URL-only BOM sources."""
    if isinstance(value, dict):
        did = str(value.get("documentId") or "").strip()
        url = str(value.get("viewHref") or value.get("href") or "").strip()
    else:
        did = ""
        url = str(value or "").strip()
    if did:
        return did
    match = re.search(
        r"(?:^|/)documents/([a-fA-F0-9]{24})(?:/|$)",
        urlparse(url).path,
    )
    return match.group(1) if match else ""


def item_source_document_location(
    value, default_base_url: str
) -> tuple[str, str] | None:
    """Return the Onshape host and document ID for a BOM item source."""
    did = item_source_document_id(value)
    if not did:
        return None
    if isinstance(value, dict):
        url = str(value.get("viewHref") or value.get("href") or "").strip()
    else:
        url = str(value or "").strip()
    parsed = urlparse(url)
    base_url = (
        f"{parsed.scheme}://{parsed.netloc}"
        if parsed.scheme and parsed.netloc
        else default_base_url.rstrip("/")
    )
    return base_url, did


def fetch_document_metadata(base_url: str, document_id: str) -> dict:
    """Fetch an Onshape document object, whose top-level name is the doc name."""
    endpoint = (
        f"{base_url.rstrip('/')}/api/{ONSHAPE_API_VERSION}/documents/"
        f"{quote(document_id, safe='')}"
    )
    return onshape_get_json(endpoint)


def source_document_names_for_rows(
    items: list[dict],
    prefixes: list[str],
    default_base_url: str,
    cache: dict[str, dict | None] | None = None,
) -> tuple[dict[str, str], list[str]]:
    """Resolve document names once per unique document used by matching parts."""
    metadata_cache = cache if cache is not None else {}
    document_names: dict[str, str] = {}
    warnings: list[str] = []
    for row in items:
        part_number = str(row.get("partNumber") or "").strip()
        if not part_number or (
            prefixes and not any(part_number.startswith(prefix) for prefix in prefixes)
        ):
            continue
        location = item_source_document_location(
            row.get("itemSource"), default_base_url
        )
        if location is None:
            warnings.append(
                f"Could not resolve Source Document for {part_number}: itemSource "
                "has no document ID; field left blank"
            )
            continue
        base_url, document_id = location
        if document_id not in metadata_cache:
            try:
                metadata_cache[document_id] = fetch_document_metadata(
                    base_url, document_id
                )
            except Exception as exc:
                metadata_cache[document_id] = None
                warnings.append(
                    f"Could not resolve Source Document for {part_number}: "
                    f"document {document_id} metadata unavailable "
                    f"({type(exc).__name__}: {exc}); field left blank"
                )
                continue
        metadata = metadata_cache[document_id]
        document_name = (
            str(metadata.get("name") or "").strip()
            if isinstance(metadata, dict)
            else ""
        )
        if document_name:
            document_names[document_id] = document_name
        else:
            warnings.append(
                f"Could not resolve Source Document for {part_number}: document "
                f"{document_id} metadata has no name or is unavailable; field left blank"
            )
    return document_names, sorted(set(warnings))


def source_document_reference(
    value, default_base_url: str
) -> OnshapeDocumentReference | None:
    if isinstance(value, dict):
        url = str(value.get("viewHref") or value.get("href") or "").strip()
        did = str(value.get("documentId") or "").strip()
        wvm_type = str(value.get("wvmType") or "").strip().lower()
        wvm_id = str(value.get("wvmId") or "").strip()
    else:
        url = str(value or "").strip()
        did = ""
        wvm_type = ""
        wvm_id = ""

    parsed = urlparse(url)
    base_url = (
        f"{parsed.scheme}://{parsed.netloc}"
        if parsed.scheme and parsed.netloc
        else default_base_url.rstrip("/")
    )
    match = re.search(
        r"/documents/([a-fA-F0-9]+)/([wvm])/([a-fA-F0-9]+)/e/",
        parsed.path,
    )
    if match:
        url_did, url_wvm_type, url_wvm_id = match.groups()
        did = did or url_did
        wvm_type = wvm_type or url_wvm_type
        wvm_id = wvm_id or url_wvm_id

    if not did or wvm_type not in ("w", "v", "m") or not wvm_id:
        return None
    return OnshapeDocumentReference(base_url, did, wvm_type, wvm_id)


def fetch_document_elements(reference: OnshapeDocumentReference) -> list[dict]:
    endpoint = (
        f"{reference.base_url}/api/{ONSHAPE_API_VERSION}/documents/d/"
        f"{reference.did}/{reference.wvm_type}/{reference.wvm_id}/elements"
    )
    elements = onshape_get_json_list(endpoint)
    if not all(isinstance(element, dict) for element in elements):
        raise RuntimeError(
            f"Unexpected Onshape elements response for document {reference.did}"
        )
    return elements


def fetch_element_metadata(
    reference: OnshapeDocumentReference, element_id: str
) -> dict:
    endpoint = (
        f"{reference.base_url}/api/{ONSHAPE_API_VERSION}/metadata/d/"
        f"{reference.did}/{reference.wvm_type}/{reference.wvm_id}/e/{element_id}"
    )
    return onshape_get_json(endpoint)


def fetch_document_revisions(base_url: str, document_id: str) -> dict:
    """Fetch every released revision in one Onshape document."""
    endpoint = (
        f"{base_url.rstrip('/')}/api/{ONSHAPE_API_VERSION}/revisions/d/"
        f"{quote(document_id, safe='')}"
    )
    return onshape_get_json(endpoint)


def normalized_part_number(value) -> str:
    return str(value or "").strip().casefold()


def discover_released_manufacturing_roots(
    master_target: OnshapeTarget, items: list[dict]
) -> tuple[list[tuple[OnshapeDocumentReference, ReleasedAssembly]], list[str]]:
    """Resolve direct child assemblies in Main to their own latest releases."""
    candidates: dict[str, set[OnshapeDocumentReference]] = {}
    warnings: list[str] = []
    for row in items:
        if not is_assembly_row(row) or indent_level(row) != 0:
            continue
        discovered_number = assembly_number(row)
        reference = source_document_reference(
            row.get("itemSource"), master_target.base_url
        )
        if reference is None:
            warnings.append(
                f"Could not resolve the source document for direct child "
                f"{discovered_number}; manufacturing root skipped"
            )
            continue
        candidates.setdefault(discovered_number, set()).add(reference)

    roots: list[tuple[OnshapeDocumentReference, ReleasedAssembly]] = []
    for candidate_number in sorted(candidates):
        references = candidates[candidate_number]
        document_keys = {
            (reference.base_url, reference.did) for reference in references
        }
        if len(document_keys) != 1:
            warnings.append(
                f"Direct child {candidate_number} resolves to multiple documents; "
                "manufacturing root skipped"
            )
            continue
        reference = sorted(
            references,
            key=lambda item: (
                item.base_url,
                item.did,
                item.wvm_type,
                item.wvm_id,
            ),
        )[0]
        latest = fetch_latest_discovered_assembly_revision(
            reference, candidate_number
        )
        if not latest or not str(latest.get("versionId") or "").strip():
            warnings.append(
                f"Direct child {candidate_number} has no released assembly revision; "
                "existing Baserow requirements were left unchanged"
            )
            continue
        released = released_assembly_from_revision(latest)
        if (
            released.part_number
            and normalized_part_number(released.part_number)
            != normalized_part_number(candidate_number)
        ):
            raise RuntimeError(
                "Onshape latest-revision response returned a different part number "
                f"for discovered child {candidate_number}"
            )
        roots.append((reference, released))

    if not candidates:
        warnings.append(
            "The master workspace BOM contains no direct A-... child assemblies"
        )
    return roots, sorted(set(warnings))


def is_drawing_element(element: dict) -> bool:
    element_type = str(
        element.get("elementType") or element.get("type") or ""
    ).strip().casefold()
    if element_type == "drawing":
        return True
    structured_markers = (
        element.get("mimeType"),
        element.get("dataType"),
        element.get("applicationType"),
    )
    if any(
        "drawing" in str(marker or "").casefold() for marker in structured_markers
    ):
        return True
    return (
        element_type == "application" or element_type.isdigit()
    ) and "drawing" in str(element.get("name") or "").casefold()


def drawing_urls_for_parts(
    items: list[dict],
    prefixes: list[str],
    default_base_url: str,
    extra_references: list[OnshapeDocumentReference] | None = None,
    revision_cache: dict[tuple[str, str], dict] | None = None,
) -> tuple[dict[str, str], list[str]]:
    """Resolve released drawings with one revision request per source document."""
    expected_by_document: dict[tuple[str, str], dict[str, str]] = {}
    all_expected: dict[str, str] = {}
    for row in items:
        part_number = str(row.get("partNumber") or "").strip()
        if not part_number or (
            prefixes and not any(part_number.startswith(prefix) for prefix in prefixes)
        ):
            continue
        all_expected[normalized_part_number(part_number)] = part_number
        reference = source_document_reference(row.get("itemSource"), default_base_url)
        if reference is None:
            continue
        document_key = (reference.base_url.rstrip("/"), reference.did)
        expected_by_document.setdefault(document_key, {})[
            normalized_part_number(part_number)
        ] = part_number

    for reference in set(extra_references or []):
        document_key = (reference.base_url.rstrip("/"), reference.did)
        expected_by_document.setdefault(document_key, {}).update(all_expected)

    cache = revision_cache if revision_cache is not None else {}
    drawing_candidates: dict[str, set[str]] = {}
    for document_key, expected in expected_by_document.items():
        if document_key not in cache:
            cache[document_key] = fetch_document_revisions(*document_key)
        payload = cache[document_key]
        revision_items = next(
            (
                payload.get(key)
                for key in ("items", "revisions", "results")
                if isinstance(payload.get(key), list)
            ),
            None,
        )
        if revision_items is None:
            raise RuntimeError(
                f"Unexpected Onshape revisions response for document "
                f"{document_key[1]}: no items array"
            )

        latest_by_part: dict[str, dict] = {}
        for revision_item in revision_items:
            if not isinstance(revision_item, dict):
                continue
            element_type = str(revision_item.get("elementType") or "").casefold()
            if element_type not in (str(DRAWING_ELEMENT_TYPE), "drawing"):
                continue
            candidate_key = normalized_part_number(revision_item.get("partNumber"))
            if candidate_key not in expected:
                continue
            current = latest_by_part.get(candidate_key)
            sort_key = (
                str(
                    revision_item.get("releaseCreatedDate")
                    or revision_item.get("createdAt")
                    or ""
                ),
                str(revision_item.get("revision") or ""),
                str(revision_item.get("versionId") or ""),
                str(revision_item.get("elementId") or ""),
            )
            current_key = (
                (
                    str(
                        current.get("releaseCreatedDate")
                        or current.get("createdAt")
                        or ""
                    ),
                    str(current.get("revision") or ""),
                    str(current.get("versionId") or ""),
                    str(current.get("elementId") or ""),
                )
                if current is not None
                else None
            )
            if current_key is None or sort_key > current_key:
                latest_by_part[candidate_key] = revision_item

        reference = OnshapeDocumentReference(
            document_key[0], document_key[1], "v", "unused"
        )
        for candidate_key, latest in latest_by_part.items():
            part_number = expected[candidate_key]
            drawing_candidates.setdefault(part_number, set()).add(
                released_drawing_url(reference, part_number, latest)
            )

    drawing_urls: dict[str, str] = {}
    warnings: list[str] = []
    for part_number in sorted(all_expected.values()):
        urls = drawing_candidates.get(part_number, set())
        if len(urls) == 1:
            drawing_urls[part_number] = next(iter(urls))
        elif not urls:
            warnings.append(
                f"No released drawing revision found for {part_number}; "
                "drawing link left blank"
            )
        else:
            warnings.append(
                f"Multiple released drawings match {part_number}; drawing link left blank"
            )
    return drawing_urls, warnings


def part_export_sources_for_parts(
    items: list[dict],
    prefixes: list[str],
    default_base_url: str,
    eligible_part_numbers: set[str] | None = None,
) -> tuple[dict[str, set[PartExportSource]], list[str]]:
    """Return the immutable configured Onshape source for each manufacturable part."""
    sources: dict[str, set[PartExportSource]] = {}
    expected_part_numbers: set[str] = set()
    for row in items:
        part_number = str(row.get("partNumber") or "").strip()
        if not part_number or (
            prefixes and not any(part_number.startswith(prefix) for prefix in prefixes)
        ):
            continue
        if (
            eligible_part_numbers is not None
            and part_number not in eligible_part_numbers
        ):
            continue
        expected_part_numbers.add(part_number)
        item_source = row.get("itemSource")
        reference = source_document_reference(item_source, default_base_url)
        if not isinstance(item_source, dict) or reference is None:
            continue
        element_id = str(item_source.get("elementId") or "").strip()
        part_id = str(item_source.get("partId") or "").strip()
        if reference.wvm_type not in ("w", "v") or not element_id or not part_id:
            continue
        _, configuration = source_url_and_configuration(item_source)
        sources.setdefault(part_number, set()).add(
            PartExportSource(
                base_url=reference.base_url.rstrip("/"),
                did=reference.did,
                wv=reference.wvm_type,
                wvid=reference.wvm_id,
                eid=element_id,
                part_id=part_id,
                configuration=configuration,
            )
        )
    warnings = [
        f"No exportable immutable Onshape part ID found for {part_number}; "
        "STEP file unavailable"
        for part_number in sorted(expected_part_numbers - set(sources))
    ]
    return sources, warnings


def safe_filename_component(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())
    return cleaned.strip("-._") or "unnamed"


def export_source_key(kind: str, coordinates: dict) -> str:
    encoded = json.dumps(
        {"cacheVersion": CAD_EXPORT_CACHE_VERSION, "kind": kind, **coordinates},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def step_export_enabled(part: dict) -> bool:
    method = str(part.get("Manufacturing Method") or "").strip().casefold()
    return method in STEP_EXPORT_METHODS


def build_file_exports(
    parts: list[dict],
    items: list[dict],
    drawing_urls: dict[str, str],
    prefixes: list[str],
    default_base_url: str,
) -> tuple[dict[str, list[FileExport]], list[str]]:
    """Build export requests without starting any Onshape translations."""
    step_part_numbers = {
        str(part.get("Part Number") or "").strip()
        for part in parts
        if step_export_enabled(part)
    }
    step_sources, warnings = part_export_sources_for_parts(
        items,
        prefixes,
        default_base_url,
        eligible_part_numbers=step_part_numbers,
    )
    exports: dict[str, list[FileExport]] = {}
    revision_by_part = {
        part["Part Number"]: str(part.get("Revision") or "").strip() for part in parts
    }

    for part_number, drawing_url in drawing_urls.items():
        drawing = parse_onshape_doc_url(drawing_url)
        stem = safe_filename_component(
            f"{part_number}_rev-{revision_by_part.get(part_number) or 'unreleased'}"
        )
        coordinates = {
            "did": drawing.did,
            "wv": drawing.wvm_type,
            "wvid": drawing.wvm_id,
            "eid": drawing.eid,
            "format": "PDF",
        }
        exports.setdefault(part_number, []).append(
            FileExport(
                part_number=part_number,
                field_name=DRAWING_PDF_FIELD,
                key_field_name=DRAWING_PDF_KEY_FIELD,
                source_key=export_source_key("drawing", coordinates),
                filename=f"{stem}.pdf",
                content_type="application/pdf",
                endpoint=(
                    f"{drawing.base_url.rstrip('/')}/api/{ONSHAPE_API_VERSION}/drawings/"
                    f"d/{drawing.did}/{drawing.wvm_type}/{drawing.wvm_id}/e/{drawing.eid}/translations"
                ),
                request_body={
                    "formatName": "PDF",
                    "storeInDocument": False,
                    "evaluateExportRule": True,
                    "notifyUser": False,
                    "triggerAutoDownload": False,
                },
                source_document_id=drawing.did,
            )
        )

    for part_number, sources in step_sources.items():
        ordered_sources = sorted(
            sources,
            key=lambda source: (
                source.did,
                source.wvid,
                source.eid,
                source.part_id,
                source.configuration,
            ),
        )
        multiple_configurations = len(ordered_sources) > 1
        for source in ordered_sources:
            coordinates = {
                "did": source.did,
                "wv": source.wv,
                "wvid": source.wvid,
                "eid": source.eid,
                "partId": source.part_id,
                "configuration": source.configuration,
                "format": "STEP",
            }
            source_key = export_source_key("part", coordinates)
            suffix = ""
            if multiple_configurations:
                suffix = "_cfg-" + source_key[:8]
            stem = safe_filename_component(
                f"{part_number}_rev-{revision_by_part.get(part_number) or 'unreleased'}{suffix}"
            )
            exports.setdefault(part_number, []).append(
                FileExport(
                    part_number=part_number,
                    field_name=STEP_FILE_FIELD,
                    key_field_name=STEP_KEY_FIELD,
                    source_key=source_key,
                    filename=f"{stem}.step",
                    content_type="application/step",
                    endpoint=(
                        f"{source.base_url}/api/{ONSHAPE_API_VERSION}/partstudios/"
                        f"d/{source.did}/{source.wv}/{source.wvid}/e/{source.eid}/translations"
                    ),
                    request_body={
                        "formatName": "STEP",
                        "storeInDocument": False,
                        "evaluateExportRule": True,
                        "notifyUser": False,
                        "triggerAutoDownload": False,
                        "partIds": source.part_id,
                        "configuration": source.configuration,
                        "grouping": True,
                        "stepVersionString": "AP242",
                    },
                    source_document_id=source.did,
                )
            )
    return exports, warnings


def decimal_quantity(value) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except InvalidOperation as exc:
        raise ValueError(f"Invalid BOM quantity: {value!r}") from exc


def number_value(value: Decimal):
    return int(value) if value == value.to_integral_value() else float(value)


def normalized_property_name(value) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def row_property(row: dict, property_name: str):
    """Read an Onshape BOM property without depending on key casing or spacing."""
    wanted = normalized_property_name(property_name)
    for key, value in row.items():
        if normalized_property_name(key) == wanted:
            return value
    return None


def operation_machine_name(value) -> str:
    """Return the exact Baserow machine choice for an Onshape method value."""
    machine = str(value or "").strip()
    normalized = normalized_property_name(machine)
    if normalized in ("", "none", "selectvalue"):
        return ""
    return MACHINE_NAME_ALIASES.get(normalized, machine)


def powder_coat_color(value) -> str:
    """Return an exact Baserow choice for the released Onshape color."""
    normalized = normalized_property_name(value)
    if normalized in ("", "none", "selectvalue"):
        return "None"
    choices = {"red": "Red", "black": "Black"}
    if normalized not in choices:
        raise ValueError(f"Unsupported Powder Coat Color value: {value!r}")
    return choices[normalized]


def fetch_part_metadata(item_source: dict, default_base_url: str) -> dict | None:
    """Read immutable metadata for one released BOM part/configuration."""
    reference = source_document_reference(item_source, default_base_url)
    element_id = str(item_source.get("elementId") or "").strip()
    part_id = str(item_source.get("partId") or "").strip()
    if reference is None or not element_id or not part_id:
        return None
    _, configuration = source_url_and_configuration(item_source)
    endpoint = (
        f"{reference.base_url}/api/{ONSHAPE_API_VERSION}/metadata/d/{reference.did}/"
        f"{reference.wvm_type}/{reference.wvm_id}/e/{quote(element_id, safe='')}/"
        f"p/{quote(part_id, safe='')}"
    )
    params = {
        "includeComputedProperties": "true",
        "thumbnail": "false",
    }
    if configuration != "default":
        params["configuration"] = configuration
    return onshape_get_json(f"{endpoint}?{urlencode(params)}")


def fetch_parts_metadata(
    reference: OnshapeDocumentReference,
    element_id: str,
    configuration: str,
) -> dict:
    """Read all part metadata for one immutable Part Studio configuration."""
    endpoint = (
        f"{reference.base_url}/api/{ONSHAPE_API_VERSION}/metadata/d/{reference.did}/"
        f"{reference.wvm_type}/{reference.wvm_id}/e/{quote(element_id, safe='')}/p"
    )
    params = {
        "includeComputedProperties": "true",
        "includeComputedAssemblyProperties": "false",
        "thumbnail": "false",
    }
    if configuration != "default":
        params["configuration"] = configuration
    return onshape_get_json(f"{endpoint}?{urlencode(params)}")


def parts_metadata_items(payload: dict) -> list[dict]:
    """Return the typed metadata entries from the bulk metadata response."""
    for key in ("items", "parts", "objects", "results"):
        items = payload.get(key)
        if isinstance(items, list) and all(isinstance(item, dict) for item in items):
            return items
    raise RuntimeError("Unexpected Onshape bulk part metadata response: no items array")


def operation_metadata_values(payload: dict) -> dict[str, object]:
    values = {}
    properties = payload.get("properties")
    if not isinstance(properties, list):
        raise RuntimeError("Unexpected Onshape part metadata: no properties array")
    for prop in properties:
        if not isinstance(prop, dict):
            continue
        name = str(prop.get("name") or prop.get("displayName") or "").strip()
        if name:
            values[normalized_property_name(name)] = prop.get("value")
    return values


def hydrate_operation_properties(
    items: list[dict],
    prefixes: list[str],
    default_base_url: str,
    bulk_cache: dict[tuple, dict[str, dict]] | None = None,
    single_cache: dict[tuple, dict | None] | None = None,
) -> list[dict]:
    """Overlay routing metadata using one request per Part Studio/configuration."""
    bulk_metadata_cache = bulk_cache if bulk_cache is not None else {}
    fallback_cache = single_cache if single_cache is not None else {}
    hydrated = [dict(original) for original in items]
    rows_by_group: dict[tuple, list[tuple[dict, dict, str]]] = {}

    for row in hydrated:
        part_number = str(row.get("partNumber") or "").strip()
        item_source = row.get("itemSource")
        if part_number and (
            not prefixes or any(part_number.startswith(prefix) for prefix in prefixes)
        ) and isinstance(item_source, dict):
            reference = source_document_reference(item_source, default_base_url)
            element_id = str(item_source.get("elementId") or "").strip()
            part_id = str(item_source.get("partId") or "").strip()
            _, configuration = source_url_and_configuration(item_source)
            if reference is not None and element_id and part_id:
                group_key = (
                    reference.base_url,
                    reference.did,
                    reference.wvm_type,
                    reference.wvm_id,
                    element_id,
                    configuration,
                )
                rows_by_group.setdefault(group_key, []).append(
                    (row, item_source, part_id)
                )

    for group_key, group_rows in rows_by_group.items():
        if group_key not in bulk_metadata_cache:
            reference = OnshapeDocumentReference(
                group_key[0], group_key[1], group_key[2], group_key[3]
            )
            payload = fetch_parts_metadata(
                reference, group_key[4], group_key[5]
            )
            bulk_metadata_cache[group_key] = {
                str(item.get("partId") or item.get("id") or ""): item
                for item in parts_metadata_items(payload)
                if str(item.get("partId") or item.get("id") or "").strip()
            }
        metadata_by_part = bulk_metadata_cache[group_key]

        for row, item_source, part_id in group_rows:
            metadata = metadata_by_part.get(part_id)
            if metadata is None:
                fallback_key = (*group_key, part_id)
                if fallback_key not in fallback_cache:
                    fallback_cache[fallback_key] = fetch_part_metadata(
                        item_source, default_base_url
                    )
                metadata = fallback_cache[fallback_key]
            if metadata is None:
                continue
            metadata_values = operation_metadata_values(metadata)
            for property_name in HYDRATED_PART_PROPERTY_NAMES:
                property_key = normalized_property_name(property_name)
                if property_key in metadata_values:
                    row[property_name] = metadata_values[property_key]
    return hydrated


def operation_machines_from_row(row: dict) -> tuple[tuple[str, str], ...]:
    operations = []
    for index, property_name in enumerate(OPERATION_PROPERTY_NAMES, start=1):
        machine = operation_machine_name(row_property(row, property_name))
        if machine:
            operations.append((f"OP{index}", machine))
    return tuple(operations)


def production_requirement_machine_fields(row: dict) -> dict:
    """Return released routing values using exact Baserow choice names."""
    fields = {}
    for index, property_name in enumerate(OPERATION_PROPERTY_NAMES, start=1):
        machine = operation_machine_name(row_property(row, property_name))
        fields[f"Machine OP{index}"] = machine or None
    return fields


def build_operation_records(requirements: list[dict]) -> list[dict]:
    """Expand each requirement's released Onshape routing into operation rows."""
    operations = []
    for requirement in requirements:
        production_key = str(requirement.get("Production Key") or "").strip()
        if not production_key:
            continue
        for operation_number, machine in requirement.get("_operation_machines", ()):
            operations.append(
                {
                    "Operation": f"{production_key}|{operation_number}",
                    "production_key": production_key,
                    "Operation Number": operation_number,
                    "Machine": machine,
                    "Active in Routing": True,
                }
            )
    return operations


def select_option_value(value) -> str:
    """Return the displayed value from a Baserow single-select response."""
    if isinstance(value, dict):
        value = value.get("value")
    return str(value or "").strip()


def operation_sequence(operation: dict) -> int:
    """Return the numeric position of an OP1 through OP4 operation."""
    label = select_option_value(operation.get("Operation Number")).upper()
    if label.startswith("OP") and label[2:].isdigit():
        return int(label[2:])
    return 999


def operation_statuses_for_routes(
    operations: list[dict], existing_rows: list[dict]
) -> dict[str, str]:
    """Gate each operation on completion of the preceding active route step.

    Planned and Ready are sync-managed queue states. Manufacturing-owned states
    are preserved, including In Progress, Blocked, Needs Rework, and Complete.
    """
    existing_by_key = {
        str(row.get("Operation") or ""): row for row in existing_rows
    }
    routes: dict[str, list[dict]] = {}
    for operation in operations:
        production_key = str(operation.get("production_key") or "").strip()
        routes.setdefault(production_key, []).append(operation)

    statuses = {}
    for route in routes.values():
        predecessor_complete = True
        for operation in sorted(route, key=operation_sequence):
            operation_key = str(operation.get("Operation") or "")
            current_status = select_option_value(
                existing_by_key.get(operation_key, {}).get("Status")
            )
            if current_status in ("", "Planned", "Ready"):
                status = "Ready" if predecessor_complete else "Planned"
            else:
                status = current_status
            statuses[operation_key] = status
            predecessor_complete = status == "Complete"
    return statuses


def build_records(
    items: list[dict],
    prefixes: list[str],
    *,
    source_root: str = "",
    source_revision: str = "",
    source_document_names: dict[str, str] | None = None,
):
    parts: dict[str, dict] = {}
    requirements: dict[str, dict] = {}
    warnings: list[str] = []

    for row in annotate_assemblies(items, source_root):
        part_number = str(row.get("partNumber") or "").strip()
        if not part_number or (prefixes and not any(part_number.startswith(p) for p in prefixes)):
            continue

        assembly_number = str(row.get("assemblyNumber") or "").strip()
        item_source = row.get("itemSource")
        source_url, configuration = source_url_and_configuration(item_source)
        source_document_id = item_source_document_id(item_source)
        source_document = (source_document_names or {}).get(
            source_document_id, ""
        )
        operation_machines = operation_machines_from_row(row)
        requirement_machine_fields = production_requirement_machine_fields(row)
        part = {
            "Part Number": part_number,
            "Name": str(row.get("name") or "").strip(),
            "Description": str(row.get("description") or "").strip(),
            "Material": material_name(row.get("material")),
            "Manufacturing Method": str(row.get("manufacturingmethod") or "").strip(),
            "Vendor": str(row.get("vendor") or "").strip(),
            "Revision": str(row.get("revision") or "").strip(),
            "OnShape Text": str(row.get("state") or "").strip(),
            "Category": str(row.get("category") or "").strip(),
            "Active": True,
        }
        previous = parts.get(part_number)
        conflict_fields = (
            "Name",
            "Material",
            "Manufacturing Method",
            "Revision",
        )
        if previous and any(
            previous.get(field) != part.get(field) for field in conflict_fields
        ):
            warnings.append(
                f"Conflicting engineering properties or revisions for {part_number}"
            )
        elif previous is None:
            parts[part_number] = part

        key = (
            f"{source_root}|{source_revision}|{assembly_number}|"
            f"{part_number}|{configuration}"
            if source_root or source_revision
            else f"{assembly_number}|{part_number}|{configuration}"
        )
        requirement = requirements.setdefault(
            key,
            {
                "Production Key": key,
                "part_number": part_number,
                "assembly_number": assembly_number,
                "Source Root": source_root,
                "Source Assembly Revision": source_revision,
                "Required Part Revision": str(row.get("revision") or "").strip(),
                "Configuration": configuration,
                "Required Quantity": Decimal("0"),
                "positions": [],
                "Onshape Source": source_url,
                "Source Document": source_document,
                "Finishing": powder_coat_color(
                    row_property(row, POWDER_COAT_PROPERTY_NAME)
                ),
                "Active in BOM": True,
                **requirement_machine_fields,
                "_operation_machines": operation_machines,
            },
        )
        existing_source_document = str(
            requirement.get("Source Document") or ""
        ).strip()
        if (
            existing_source_document
            and source_document
            and existing_source_document != source_document
        ):
            warnings.append(
                f"Conflicting source documents for {part_number} in {key}"
            )
        elif not existing_source_document and source_document:
            requirement["Source Document"] = source_document
        existing_machines = tuple(requirement.get("_operation_machines") or ())
        if existing_machines and operation_machines and existing_machines != operation_machines:
            warnings.append(
                f"Conflicting manufacturing operations for {part_number} in {key}"
            )
        elif not existing_machines and operation_machines:
            requirement["_operation_machines"] = operation_machines
        requirement["Required Quantity"] += decimal_quantity(row.get("quantity"))
        position = str(row.get("item") or "").strip()
        if position and position not in requirement["positions"]:
            requirement["positions"].append(position)

    for requirement in requirements.values():
        requirement["Required Quantity"] = number_value(requirement["Required Quantity"])
        requirement["BOM Positions"] = ", ".join(requirement.pop("positions"))
    return list(parts.values()), list(requirements.values()), sorted(set(warnings))


class BaserowClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Token {token}"})

    def _url(self, table_id: int, suffix: str = "") -> str:
        return f"{self.base_url}/database/rows/table/{table_id}/{suffix}?user_field_names=true"

    def list_rows(self, table_id: int) -> list[dict]:
        rows = []
        page = 1
        while True:
            response = self.session.get(self._url(table_id), params={"user_field_names": "true", "page": page, "size": 200}, timeout=60)
            response.raise_for_status()
            payload = response.json()
            rows.extend(payload.get("results", []))
            if not payload.get("next"):
                return rows
            page += 1

    def create_one(self, table_id: int, fields: dict) -> dict:
        response = self.session.post(self._url(table_id), json=fields, timeout=60)
        response.raise_for_status()
        return response.json()

    def update_one(self, table_id: int, row_id: int, fields: dict) -> dict:
        response = self.session.patch(self._url(table_id, str(row_id) + "/"), json=fields, timeout=60)
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _raise_batch_error_with_context(
        response, table_id: int, operation: str, items: list[dict]
    ) -> None:
        try:
            response.raise_for_status()
        except Exception as exc:
            try:
                response_detail = response.json()
            except Exception:
                response_detail = str(getattr(response, "text", "") or "").strip()
            identifying_fields = (
                "id",
                "Production Key",
                "Part Number",
                "Assembly Number",
                "Operation",
                "Operation Number",
                "Machine",
                "Machine OP1",
                "Machine OP2",
                "Machine OP3",
                "Machine OP4",
            )
            item_identifiers = []
            for batch_index, item in enumerate(items):
                identifier = {"batch_index": batch_index}
                for field in identifying_fields:
                    value = item.get(field)
                    if value not in (None, "", [], {}):
                        identifier[field] = value
                item_identifiers.append(identifier)
            detail_text = json.dumps(
                response_detail, sort_keys=True, default=str
            )[:10000]
            identifiers_text = json.dumps(
                item_identifiers, sort_keys=True, default=str
            )[:20000]
            raise RuntimeError(
                f"Baserow batch {operation} failed for table {table_id} "
                f"with HTTP {getattr(response, 'status_code', 'unknown')}; "
                f"response={detail_text}; "
                f"batch_item_identifiers={identifiers_text}"
            ) from exc

    def batch_create(self, table_id: int, items: list[dict]) -> list[dict]:
        created = []
        for start in range(0, len(items), BATCH_SIZE):
            batch = items[start:start+BATCH_SIZE]
            response = self.session.post(
                self._url(table_id, "batch/"),
                json={"items": batch},
                timeout=60,
            )
            self._raise_batch_error_with_context(
                response, table_id, "create", batch
            )
            created.extend(response.json().get("items", []))
        return created

    def batch_update(self, table_id: int, items: list[dict]) -> list[dict]:
        updated = []
        for start in range(0, len(items), BATCH_SIZE):
            batch = items[start:start+BATCH_SIZE]
            response = self.session.patch(
                self._url(table_id, "batch/"),
                json={"items": batch},
                timeout=60,
            )
            self._raise_batch_error_with_context(
                response, table_id, "update", batch
            )
            updated.extend(response.json().get("items", []))
        return updated

    def upload_file(self, filename: str, content: bytes, content_type: str) -> dict:
        response = self.session.post(
            f"{self.base_url}/user-files/upload-file/",
            files={"file": (filename, content, content_type)},
            timeout=120,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not payload.get("name"):
            raise RuntimeError("Unexpected Baserow file upload response: no file name")
        return payload


def stale_root_revisions(
    released_roots: list[ReleasedAssembly], discovery_master: str = ""
) -> tuple[set[str], bool]:
    """Return stale normalized root numbers and discovery-membership status."""
    client = BaserowClient(
        require_env("BASEROW_API_URL"), require_env("BASEROW_TOKEN")
    )
    assemblies_table_id = int(require_env("BASEROW_ASSEMBLIES_TABLE_ID"))
    rows = client.list_rows(assemblies_table_id)
    rows_by_number = {
        normalized_part_number(row.get("Assembly Number")): row
        for row in rows
        if str(row.get("Assembly Number") or "").strip()
    }

    root_numbers = {
        normalized_part_number(released.part_number) for released in released_roots
    }
    stale: set[str] = set()
    for released in released_roots:
        revision = str(released.revision or "").strip()
        root_number = normalized_part_number(released.part_number)
        current = rows_by_number.get(root_number)
        if (
            not revision
            or current is None
            or str(current.get("Latest Released Revision") or "").strip()
            != revision
            or str(current.get("Sync Schema Version") or "").strip()
            != SYNC_SCHEMA_VERSION
        ):
            stale.add(root_number)

    membership_changed = False
    if discovery_master:
        previously_present = {
            normalized_part_number(row.get("Assembly Number"))
            for row in rows
            if str(row.get("Discovery Master") or "").strip() == discovery_master
            and str(row.get("Integration Status") or "").strip()
            != "Missing from Main — Review"
        }
        if previously_present != root_numbers:
            membership_changed = True

    return stale, membership_changed


def all_root_revisions_are_current(
    released_roots: list[ReleasedAssembly], discovery_master: str = ""
) -> bool:
    """Return whether Baserow already represents every resolved root revision."""
    stale, membership_changed = stale_root_revisions(
        released_roots, discovery_master
    )
    return not stale and not membership_changed


def aggregate_export_key(exports: list[FileExport]) -> str:
    encoded = "\n".join(sorted(export.source_key for export in exports)).encode()
    return hashlib.sha256(encoded).hexdigest()


def existing_file_is_current(
    row: dict, field_name: str, key_field_name: str, exports: list[FileExport]
) -> bool:
    files = row.get(field_name)
    return (
        str(row.get(key_field_name) or "") == aggregate_export_key(exports)
        and isinstance(files, list)
        and len(files) == len(exports)
    )


def start_file_translation(export: FileExport) -> dict:
    payload = onshape_post_json(export.endpoint, export.request_body)
    translation_id = str(payload.get("id") or "").strip()
    if not translation_id:
        raise RuntimeError(
            f"Onshape did not return a translation ID for {export.filename}"
        )
    return payload


def wait_for_translation(export: FileExport, initial: dict) -> dict:
    payload = initial
    timeout_seconds = int(os.environ.get("ONSHAPE_EXPORT_TIMEOUT_SECONDS", "300"))
    deadline = time.monotonic() + timeout_seconds
    poll_index = 0
    while True:
        state = str(payload.get("requestState") or "").upper()
        if state == "DONE":
            return payload
        if state == "FAILED":
            reason = str(payload.get("failureReason") or "unknown reason")
            raise RuntimeError(f"Onshape export failed for {export.filename}: {reason}")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"Onshape export timed out for {export.filename}")
        delay = EXPORT_POLL_SECONDS[min(poll_index, len(EXPORT_POLL_SECONDS) - 1)]
        time.sleep(min(delay, remaining))
        poll_index += 1
        translation_id = str(payload.get("id") or "").strip()
        status_url = (
            f"{urlparse(export.endpoint).scheme}://{urlparse(export.endpoint).netloc}/"
            f"api/{ONSHAPE_API_VERSION}/translations/{translation_id}"
        )
        payload = onshape_get_json(status_url)


def download_translation(export: FileExport, translation: dict) -> bytes:
    external_ids = translation.get("resultExternalDataIds")
    if not isinstance(external_ids, list) or len(external_ids) != 1:
        raise RuntimeError(
            f"Onshape returned {len(external_ids) if isinstance(external_ids, list) else 0} "
            f"files for {export.filename}; expected one"
        )
    foreign_id = quote(str(external_ids[0]), safe="")
    base_url = f"{urlparse(export.endpoint).scheme}://{urlparse(export.endpoint).netloc}"
    url = (
        f"{base_url}/api/{ONSHAPE_API_VERSION}/documents/d/"
        f"{export.source_document_id}/externaldata/{foreign_id}"
    )
    content = onshape_download(url)
    if not content:
        raise RuntimeError(f"Onshape returned an empty file for {export.filename}")
    return content


def baserow_file_references(value) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    return [
        {"name": str(item["name"])}
        for item in value
        if isinstance(item, dict) and item.get("name")
    ]


def completed_export_filename(export: FileExport, translation: dict) -> str:
    filename = str(
        translation.get("exportRuleFileName")
        or translation.get("name")
        or export.filename
    ).strip()
    if export.field_name == DRAWING_PDF_FIELD:
        extensions = (".pdf",)
        default_extension = ".pdf"
    else:
        extensions = (".step", ".stp")
        default_extension = ".step"
    if not filename.casefold().endswith(extensions):
        filename += default_extension
    return filename


def attach_exported_files(
    client: BaserowClient,
    parts: list[dict],
    existing_rows: list[dict],
    exports_by_part: dict[str, list[FileExport]],
    warnings: list[str],
) -> tuple[int, int]:
    """Export changed CAD files and add Baserow file values to desired part rows."""
    existing_by_part = {
        str(row.get("Part Number") or ""): row for row in existing_rows
    }
    part_by_number = {part["Part Number"]: part for part in parts}
    pending_groups: list[tuple[dict, list[FileExport]]] = []
    cached_groups = 0

    for part_number, part in part_by_number.items():
        by_field: dict[str, list[FileExport]] = {}
        for export in exports_by_part.get(part_number, []):
            by_field.setdefault(export.field_name, []).append(export)
        existing = existing_by_part.get(part_number, {})
        for field_name, key_field_name in (
            (DRAWING_PDF_FIELD, DRAWING_PDF_KEY_FIELD),
            (STEP_FILE_FIELD, STEP_KEY_FIELD),
        ):
            group = by_field.get(field_name, [])
            part[field_name] = baserow_file_references(existing.get(field_name))
            part[key_field_name] = str(existing.get(key_field_name) or "")
            if not group:
                continue
            elif existing_file_is_current(existing, field_name, key_field_name, group):
                cached_groups += 1
            else:
                pending_groups.append((part, group))

    started: list[tuple[dict, list[FileExport], list[tuple[FileExport, dict]]]] = []
    for part, group in pending_groups:
        translations: list[tuple[FileExport, dict]] = []
        try:
            for export in group:
                translations.append((export, start_file_translation(export)))
            started.append((part, group, translations))
        except Exception as exc:
            warnings.append(
                f"Could not start {group[0].field_name} export for "
                f"{group[0].part_number}: {exc}"
            )

    uploaded_groups = 0
    for part, group, translations in started:
        try:
            attachments = []
            for export, initial in translations:
                completed = wait_for_translation(export, initial)
                content = download_translation(export, completed)
                filename_metadata = {
                    **initial,
                    **{
                        key: value
                        for key, value in completed.items()
                        if value not in (None, "")
                    },
                }
                uploaded = client.upload_file(
                    completed_export_filename(export, filename_metadata),
                    content,
                    export.content_type,
                )
                attachments.append({"name": uploaded["name"]})
            part[group[0].field_name] = attachments
            part[group[0].key_field_name] = aggregate_export_key(group)
            uploaded_groups += 1
        except Exception as exc:
            warnings.append(
                f"Could not refresh {group[0].field_name} for "
                f"{group[0].part_number}: {exc}"
            )
    return uploaded_groups, cached_groups


def comparable(value):
    if isinstance(value, list):
        normalized = []
        for item in value:
            if isinstance(item, dict):
                item = item.get("id", item.get("name", item))
            normalized.append(json.dumps(item, sort_keys=True, default=str))
        return sorted(normalized)
    if isinstance(value, dict) and "value" in value:
        return comparable(value.get("value"))
    return value if value is not None else ""


def changed(existing: dict, desired: dict, fields: tuple[str, ...]) -> bool:
    return any(comparable(existing.get(field)) != comparable(desired.get(field)) for field in fields)


def linked_row_ids(value) -> set[int]:
    ids = set()
    for item in value if isinstance(value, list) else []:
        row_id = item.get("id") if isinstance(item, dict) else item
        try:
            ids.add(int(row_id))
        except (TypeError, ValueError):
            continue
    return ids


def upsert_table(
    client: BaserowClient,
    table_id: int,
    key_field: str,
    desired: list[dict],
    update_fields: tuple[str, ...],
    change_flag_field: str | None = None,
):
    existing = client.list_rows(table_id)
    by_key = {str(row.get(key_field) or ""): row for row in existing}
    creates, updates = [], []
    for fields in desired:
        current = by_key.get(str(fields[key_field]))
        if current is None:
            creates.append({**fields, **({change_flag_field: False} if change_flag_field else {})})
        elif changed(current, fields, update_fields):
            updates.append({"id": current["id"], **fields, **({change_flag_field: True} if change_flag_field else {})})
    created = client.batch_create(table_id, creates) if creates else []
    updated = client.batch_update(table_id, updates) if updates else []
    return len(created), len(updated), len(desired) - len(creates) - len(updates)


def sync_to_baserow(
    parts: list[dict],
    requirements: list[dict],
    warnings: list[str],
    source_rows: int,
    exports_by_part: dict[str, list[FileExport]],
    sync_cad_files: bool,
    operations: list[dict] | None = None,
    assembly_records: list[dict] | None = None,
    synced_roots: set[str] | None = None,
    discovery_master: str = "",
) -> dict:
    client = BaserowClient(require_env("BASEROW_API_URL"), require_env("BASEROW_TOKEN"))
    table_ids = {
        "sync": int(require_env("BASEROW_SYNC_RUNS_TABLE_ID")),
        "parts": int(require_env("BASEROW_PARTS_TABLE_ID")),
        "requirements": int(require_env("BASEROW_REQUIREMENTS_TABLE_ID")),
        "operations": int(require_env("BASEROW_OPERATIONS_TABLE_ID")),
        "assemblies": int(require_env("BASEROW_ASSEMBLIES_TABLE_ID")),
        "finishing": int(require_env("BASEROW_FINISHING_TABLE_ID")),
    }
    started = utc_now()
    run = client.create_one(table_ids["sync"], {"Started At": started, "Result": "Running", "Source Rows": source_rows})
    try:
        now = utc_now()
        assembly_records = assembly_records or []
        operations = operations or []
        synced_roots = synced_roots or {
            str(requirement.get("Source Root") or "")
            for requirement in requirements
            if requirement.get("Source Root")
        }
        assembly_numbers = {
            str(requirement.get("assembly_number") or "")
            for requirement in requirements
            if requirement.get("assembly_number")
        } | {
            str(assembly.get("Assembly Number") or "")
            for assembly in assembly_records
            if assembly.get("Assembly Number")
        }
        assemblies = [
            {"Assembly Number": number, "Active": True}
            for number in sorted(assembly_numbers)
        ]
        assembly_fields = ("Assembly Number", "Active")
        upsert_table(client, table_ids["assemblies"], "Assembly Number", assemblies, assembly_fields)
        assembly_rows = client.list_rows(table_ids["assemblies"])
        root_assembly_fields: tuple[str, ...] = ()
        supported_assembly_records: list[dict] = []
        if assembly_records:
            available_assembly_fields = {
                field for row in assembly_rows for field in row
            }
            candidate_assembly_fields = (
                "Subsystem Name",
                "Active",
                "Latest Released Revision",
                "Master Baseline Revision",
                "Integration Status",
                "Discovery Master",
                "Onshape Source",
                "Last Synced At",
                "Sync Schema Version",
            )
            root_assembly_fields = tuple(
                field
                for field in candidate_assembly_fields
                if field in available_assembly_fields
            )
            supported_assembly_records = [
                {
                    field: value
                    for field, value in assembly.items()
                    if field == "Assembly Number" or field in root_assembly_fields
                }
                for assembly in assembly_records
            ]

        missing_from_master = []
        if discovery_master and assembly_rows:
            available_assembly_fields = {
                field for row in assembly_rows for field in row
            }
            if {
                "Discovery Master",
                "Integration Status",
            }.issubset(available_assembly_fields):
                missing_from_master = [
                    {
                        "id": row["id"],
                        "Integration Status": "Missing from Main — Review",
                    }
                    for row in assembly_rows
                    if str(row.get("Discovery Master") or "").strip()
                    == discovery_master
                    and str(row.get("Assembly Number") or "").strip()
                    not in synced_roots
                    and str(row.get("Integration Status") or "").strip()
                    != "Missing from Main — Review"
                ]
                if missing_from_master:
                    client.batch_update(
                        table_ids["assemblies"], missing_from_master
                    )
        assembly_ids = {str(r.get("Assembly Number") or ""): r["id"] for r in assembly_rows}

        part_rows = client.list_rows(table_ids["parts"])
        files_uploaded = files_cached = 0
        if sync_cad_files:
            required_file_fields = (
                DRAWING_PDF_FIELD,
                DRAWING_PDF_KEY_FIELD,
                STEP_FILE_FIELD,
                STEP_KEY_FIELD,
            )
            missing_fields = [
                field
                for field in required_file_fields
                if part_rows and not any(field in row for row in part_rows)
            ]
            if missing_fields:
                raise RuntimeError(
                    "Create the required fields on the Baserow Parts table before "
                    "enabling CAD file sync: " + ", ".join(missing_fields)
                )
            files_uploaded, files_cached = attach_exported_files(
                client, parts, part_rows, exports_by_part, warnings
            )
        for part in parts:
            part["Last Synced At"] = now
        part_fields = [
            "Name",
            "Description",
            "Material",
            "Manufacturing Method",
            "Vendor",
            "Revision",
            "OnShape Text",
            "Category",
            "Onshape Drawing",
            "Active",
        ]
        if sync_cad_files:
            part_fields.extend(
                (
                    DRAWING_PDF_FIELD,
                    DRAWING_PDF_KEY_FIELD,
                    STEP_FILE_FIELD,
                    STEP_KEY_FIELD,
                )
            )
        upsert_table(
            client, table_ids["parts"], "Part Number", parts, tuple(part_fields)
        )
        part_rows = client.list_rows(table_ids["parts"])
        part_ids = {str(r.get("Part Number") or ""): r["id"] for r in part_rows}

        existing_requirements = client.list_rows(table_ids["requirements"])
        available_requirement_fields = {
            field for row in existing_requirements for field in row
        }
        desired_requirements = []
        for requirement in requirements:
            fields = {
                k: v
                for k, v in requirement.items()
                if k not in ("part_number", "assembly_number", "_operation_machines")
            }
            fields["Part"] = [part_ids[requirement["part_number"]]]
            fields["Assembly"] = [assembly_ids[requirement["assembly_number"]]] if requirement["assembly_number"] else []
            fields["Last Synced At"] = now
            if available_requirement_fields:
                fields = {
                    field: value
                    for field, value in fields.items()
                    if field in available_requirement_fields
                }
            desired_requirements.append(fields)

        source_fields = tuple(
            field
            for field in PRODUCTION_REQUIREMENT_MANAGED_FIELDS
            if not available_requirement_fields
            or field in available_requirement_fields
        )
        created, updated, unchanged = upsert_table(
            client,
            table_ids["requirements"],
            "Production Key",
            desired_requirements,
            source_fields,
            change_flag_field="Engineering Changed",
        )

        existing_requirements = client.list_rows(table_ids["requirements"])
        desired_keys = {r["Production Key"] for r in desired_requirements}
        desired_part_configurations = {
            (
                fields["Part"][0],
                str(fields.get("Configuration") or "default"),
            )
            for fields in desired_requirements
            if fields.get("Part")
        }
        deactivate = []
        for row in existing_requirements:
            row_source_root = str(row.get("Source Root") or "").strip()
            linked = row.get("Assembly") or []
            assembly_names = {str(x.get("value") or "") for x in linked if isinstance(x, dict)}
            row_key = str(row.get("Production Key") or "")
            if not row_source_root and row_key.count("|") >= 4:
                row_source_root = row_key.split("|", 1)[0]
            part_links = row.get("Part") or []
            row_part_id = next(
                (
                    item.get("id")
                    for item in part_links
                    if isinstance(item, dict) and item.get("id") is not None
                ),
                None,
            )
            is_matching_legacy_row = (
                not row_source_root
                and not assembly_names
                and row_key.startswith("|")
                and (
                    row_part_id,
                    str(row.get("Configuration") or "default"),
                )
                in desired_part_configurations
            )
            is_synced_scope = row_source_root in synced_roots or (
                not row_source_root and bool(assembly_names & synced_roots)
            ) or is_matching_legacy_row
            if (
                is_synced_scope
                and row.get("Production Key") not in desired_keys
                and row.get("Active in BOM")
            ):
                deactivate.append({"id": row["id"], "Active in BOM": False, "Engineering Changed": True})
        if deactivate:
            client.batch_update(table_ids["requirements"], deactivate)

        requirement_rows_by_key = {
            str(row.get("Production Key") or ""): row
            for row in client.list_rows(table_ids["requirements"])
        }
        synced_requirement_ids = {
            int(row["id"])
            for row in requirement_rows_by_key.values()
            if str(row.get("Source Root") or "").strip() in synced_roots
        }

        desired_finishing = []
        for requirement in requirements:
            color = str(requirement.get("Finishing") or "None")
            if color not in ("Red", "Black"):
                continue
            production_key = str(requirement.get("Production Key") or "")
            requirement_row = requirement_rows_by_key.get(production_key)
            if requirement_row is None:
                raise RuntimeError(
                    "No Baserow Production Requirement row found for finishing "
                    f"queue item {production_key or '(unnamed)'}"
                )
            desired_finishing.append(
                {
                    "Production Key": production_key,
                    "Production Requirement": [requirement_row["id"]],
                    "Powder Coat Color": color,
                    "Required Quantity": requirement["Required Quantity"],
                    "Active": True,
                    "Last Synced At": now,
                }
            )
        # Machinist is assigned by manufacturing and must survive every resync.
        # Finishing also has no claimed/completed quantity fields: each action
        # represents the full Required Quantity for the Production Requirement.
        finishing_fields = (
            "Production Requirement",
            "Powder Coat Color",
            "Required Quantity",
            "Active",
            "Last Synced At",
        )
        (
            finishing_created,
            finishing_updated,
            finishing_unchanged,
        ) = upsert_table(
            client,
            table_ids["finishing"],
            "Production Key",
            desired_finishing,
            finishing_fields,
        )
        desired_finishing_keys = {
            row["Production Key"] for row in desired_finishing
        }
        deactivate_finishing = [
            {"id": row["id"], "Active": False, "Last Synced At": now}
            for row in client.list_rows(table_ids["finishing"])
            if str(row.get("Production Key") or "") not in desired_finishing_keys
            and row.get("Active") is not False
            and bool(
                linked_row_ids(row.get("Production Requirement"))
                & synced_requirement_ids
            )
        ]
        if deactivate_finishing:
            client.batch_update(table_ids["finishing"], deactivate_finishing)

        existing_operations = client.list_rows(table_ids["operations"])
        operation_statuses = operation_statuses_for_routes(
            operations, existing_operations
        )
        desired_operations = []
        for operation in operations:
            production_key = str(operation.get("production_key") or "")
            requirement_row = requirement_rows_by_key.get(production_key)
            if requirement_row is None:
                raise RuntimeError(
                    f"No Baserow Production Requirement row found for operation "
                    f"{operation.get('Operation') or '(unnamed)'}"
                )
            desired_operations.append(
                {
                    key: value
                    for key, value in {
                        **operation,
                        "Production Requirement": [requirement_row["id"]],
                        "Status": operation_statuses[
                            str(operation.get("Operation") or "")
                        ],
                    }.items()
                    if key != "production_key"
                }
            )

        operation_fields = (
            "Production Requirement",
            "Operation Number",
            "Machine",
            "Status",
            "Active in Routing",
        )
        operations_created, operations_updated, operations_unchanged = upsert_table(
            client,
            table_ids["operations"],
            "Operation",
            desired_operations,
            operation_fields,
        )
        desired_operation_keys = {
            operation["Operation"] for operation in desired_operations
        }
        deactivate_operations = [
            {"id": row["id"], "Active in Routing": False}
            for row in client.list_rows(table_ids["operations"])
            if row.get("Operation") not in desired_operation_keys
            and row.get("Active in Routing") is not False
            and bool(
                linked_row_ids(row.get("Production Requirement"))
                & synced_requirement_ids
            )
        ]
        if deactivate_operations:
            client.batch_update(table_ids["operations"], deactivate_operations)

        # Record the root revision only after the dependent tables succeed. This
        # value is the next run's early-exit marker, so writing it earlier could
        # hide a partial failure and prevent a retry.
        if root_assembly_fields:
            upsert_table(
                client,
                table_ids["assemblies"],
                "Assembly Number",
                supported_assembly_records,
                root_assembly_fields,
            )

        summary = {
            "created": created,
            "updated": updated,
            "unchanged": unchanged,
            "deactivated": len(deactivate),
            "roots_missing_from_master": len(missing_from_master),
            "file_groups_uploaded": files_uploaded,
            "file_groups_cached": files_cached,
            "operations_created": operations_created,
            "operations_updated": operations_updated,
            "operations_unchanged": operations_unchanged,
            "operations_deactivated": len(deactivate_operations),
            "finishing_created": finishing_created,
            "finishing_updated": finishing_updated,
            "finishing_unchanged": finishing_unchanged,
            "finishing_deactivated": len(deactivate_finishing),
        }
        warnings = sorted(set(warnings))
        client.update_one(table_ids["sync"], run["id"], {
            "Finished At": utc_now(),
            "Result": "Partial" if warnings else "Success",
            "Requirements Created": created,
            "Requirements Updated": updated,
            "Requirements Unchanged": unchanged,
            "Requirements Deactivated": len(deactivate),
            "Warnings": "\n".join(warnings),
            "GitHub Run URL": os.environ.get("GITHUB_RUN_URL", ""),
        })
        return summary
    except Exception as exc:
        try:
            client.update_one(table_ids["sync"], run["id"], {"Finished At": utc_now(), "Result": "Failed", "Error": str(exc)[:10000]})
        finally:
            raise


def environment_flag(name: str) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if value in ("", "0", "false", "no", "off"):
        return False
    if value in ("1", "true", "yes", "on"):
        return True
    raise ValueError(f"{name} must be a boolean value")


def merge_root_parts(
    part_groups: list[list[dict]], warnings: list[str]
) -> list[dict]:
    """Merge root part records without silently replacing conflicting revisions."""
    merged: dict[str, dict] = {}
    compared_fields = (
        "Name",
        "Description",
        "Material",
        "Manufacturing Method",
        "Vendor",
        "Revision",
        "Category",
    )
    for parts in part_groups:
        for part in parts:
            part_number = part["Part Number"]
            current = merged.get(part_number)
            if current is None:
                merged[part_number] = dict(part)
                continue
            conflicts = [
                field
                for field in compared_fields
                if current.get(field)
                and part.get(field)
                and current.get(field) != part.get(field)
            ]
            if conflicts:
                warnings.append(
                    f"{part_number} differs across manufacturing roots in "
                    + ", ".join(conflicts)
                )
            for field, value in part.items():
                if not current.get(field) and value:
                    current[field] = value
    return [merged[key] for key in sorted(merged)]


def merge_root_exports(
    export_groups: list[dict[str, list[FileExport]]]
) -> dict[str, list[FileExport]]:
    merged: dict[str, dict[tuple[str, str], FileExport]] = {}
    for exports_by_part in export_groups:
        for part_number, exports in exports_by_part.items():
            by_source = merged.setdefault(part_number, {})
            for export in exports:
                by_source[(export.field_name, export.source_key)] = export
    return {
        part_number: sorted(
            by_source.values(),
            key=lambda export: (export.field_name, export.filename, export.source_key),
        )
        for part_number, by_source in sorted(merged.items())
    }


def integration_status(latest_revision: str, master_revision: str, compared: bool) -> str:
    if not compared:
        return "Not Compared"
    if not master_revision:
        return "Not in Master"
    if latest_revision == master_revision:
        return "Current in Master"
    return "Newer Revision Available"


def run_sync(
    target: OnshapeTarget | list[OnshapeTarget],
    prefixes: list[str],
    *,
    dry_run: bool = False,
    output_json: str = "",
    sync_cad_files: bool = False,
    master_target: OnshapeTarget | None = None,
    discover_from_master: bool = False,
) -> dict:
    targets = target if isinstance(target, list) else [target]
    if not targets:
        raise ValueError("At least one manufacturing-root assembly URL is required")

    root_results: list[dict] = []
    part_groups: list[list[dict]] = []
    requirements: list[dict] = []
    warning_items: list[str] = []
    export_groups: list[dict[str, list[FileExport]]] = []
    seen_roots: set[str] = set()
    discovery_master_url = ""
    master_workspace_items: list[dict] = []
    root_sources: list[tuple[OnshapeDocumentReference, ReleasedAssembly]] = []
    document_metadata_cache: dict[str, dict | None] = {}
    bulk_part_metadata_cache: dict[tuple, dict[str, dict]] = {}
    single_part_metadata_cache: dict[tuple, dict | None] = {}
    drawing_revision_cache: dict[tuple[str, str], dict] = {}

    if discover_from_master:
        if len(targets) != 1:
            raise ValueError("Master discovery requires exactly one assembly URL")
        discovery_target = targets[0]
        if discovery_target.wvm_type != "w":
            raise ValueError(
                "The master discovery URL must point to an assembly in Main"
            )
        discovery_master_url = onshape_target_url(discovery_target)
        master_workspace_items = fetch_bom(
            discovery_target, generate_if_absent=True
        )
        root_sources, discovery_warnings = discover_released_manufacturing_roots(
            discovery_target, master_workspace_items
        )
        warning_items.extend(discovery_warnings)
        if not root_sources:
            raise RuntimeError(
                "No released direct-child manufacturing roots were discovered; "
                "Baserow was not changed"
            )
        master_target = None
    else:
        for root_target in targets:
            try:
                released = resolve_latest_released_assembly(root_target)
            except Exception as exc:
                warning = (
                    "Manufacturing root "
                    f"{onshape_target_url(root_target)} could not be resolved and "
                    "was skipped; existing Baserow requirements were left "
                    f"unchanged. {type(exc).__name__}: {exc}"
                )
                warning_items.append(warning)
                print(f"WARNING: {warning}", flush=True)
                continue
            root_sources.append(
                (
                    OnshapeDocumentReference(
                        root_target.base_url.rstrip("/"),
                        root_target.did,
                        root_target.wvm_type,
                        root_target.wvm_id,
                    ),
                    released,
                )
            )
        if not root_sources:
            raise RuntimeError(
                "No configured manufacturing roots could be resolved; "
                "Baserow was not changed"
            )

    resolved_root_numbers: set[str] = set()
    for _, released in root_sources:
        source_root = released.part_number.strip()
        if not source_root:
            raise RuntimeError(
                "Released manufacturing-root assembly has no Part number"
            )
        normalized_root = normalized_part_number(source_root)
        if normalized_root in resolved_root_numbers:
            raise ValueError(
                f"Manufacturing root {source_root} is configured more than once"
            )
        resolved_root_numbers.add(normalized_root)

    if not dry_run:
        resolved_root_sources = list(root_sources)
        stale_roots, membership_changed = stale_root_revisions(
            [released for _, released in resolved_root_sources],
            discovery_master_url,
        )
        if not stale_roots and not membership_changed:
            result = {
                "skipped": True,
                "reason": "All manufacturing-root revisions are already current",
                "roots_checked": len(resolved_root_sources),
                "source_revisions": [
                    released.as_dict() for _, released in resolved_root_sources
                ],
            }
            print(json.dumps(result, indent=2))
            return result
        # Discovery membership changes require a complete pass so missing roots
        # can be marked without deactivating requirements for unchanged roots.
        if not membership_changed:
            root_sources = [
                source
                for source in resolved_root_sources
                if normalized_part_number(source[1].part_number) in stale_roots
            ]
            print(
                f"Incremental sync: processing {len(root_sources)} changed root(s) "
                f"of {len(resolved_root_sources)} resolved"
            )

    for root_reference, released in root_sources:
        source_root = released.part_number.strip()
        if source_root in seen_roots:
            raise ValueError(
                f"Manufacturing root {source_root} is configured more than once"
            )
        seen_roots.add(source_root)

        released_target = released.bom_target(root_reference.base_url)
        raw_items = fetch_bom(released_target)
        raw_items = hydrate_operation_properties(
            raw_items,
            prefixes,
            root_reference.base_url,
            bulk_part_metadata_cache,
            single_part_metadata_cache,
        )
        source_document_names, document_warnings = source_document_names_for_rows(
            raw_items,
            prefixes,
            root_reference.base_url,
            document_metadata_cache,
        )
        root_parts, root_requirements, root_warnings = build_records(
            raw_items,
            prefixes,
            source_root=source_root,
            source_revision=released.revision,
            source_document_names=source_document_names,
        )
        drawing_urls, drawing_warnings = drawing_urls_for_parts(
            raw_items,
            prefixes,
            root_reference.base_url,
            [
                OnshapeDocumentReference(
                    released_target.base_url.rstrip("/"),
                    released_target.did,
                    released_target.wvm_type,
                    released_target.wvm_id,
                )
            ],
            drawing_revision_cache,
        )
        for part in root_parts:
            part["Onshape Drawing"] = drawing_urls.get(part["Part Number"], "")

        root_exports: dict[str, list[FileExport]] = {}
        export_warnings: list[str] = []
        if sync_cad_files:
            root_exports, export_warnings = build_file_exports(
                root_parts,
                raw_items,
                drawing_urls,
                prefixes,
                root_reference.base_url,
            )
        root_results.append(
            {
                "reference": root_reference,
                "released": released,
                "items": raw_items,
                "parts": root_parts,
                "requirements": root_requirements,
                "drawing_count": len(drawing_urls),
            }
        )
        part_groups.append(root_parts)
        requirements.extend(root_requirements)
        export_groups.append(root_exports)
        warning_items.extend(
            document_warnings
            + root_warnings
            + drawing_warnings
            + export_warnings
        )

    master_released: ReleasedAssembly | None = None
    master_items: list[dict] = []
    master_revisions: dict[str, str] = {}
    if master_target is not None:
        master_released = resolve_latest_released_assembly(master_target)
        master_items = fetch_bom(
            master_released.bom_target(master_target.base_url)
        )
        master_revisions = assembly_revisions(master_items)
        if master_released.part_number:
            master_revisions[master_released.part_number] = master_released.revision

    assembly_records = []
    for result in root_results:
        released = result["released"]
        master_revision = master_revisions.get(released.part_number, "")
        assembly_records.append(
            {
                "Assembly Number": released.part_number,
                "Subsystem Name": released.name,
                "Active": True,
                "Latest Released Revision": released.revision,
                "Master Baseline Revision": master_revision,
                "Integration Status": (
                    "Discovered — Master Unreleased"
                    if discover_from_master
                    else integration_status(
                        released.revision,
                        master_revision,
                        master_target is not None,
                    )
                ),
                "Discovery Master": discovery_master_url,
                "Onshape Source": released.view_ref
                or onshape_target_url(
                    released.bom_target(result["reference"].base_url)
                ),
                "Last Synced At": utc_now(),
                "Sync Schema Version": SYNC_SCHEMA_VERSION,
            }
        )

    parts = merge_root_parts(part_groups, warning_items)
    operations = build_operation_records(requirements)
    exports_by_part = merge_root_exports(export_groups)
    warnings = sorted(set(warning_items))
    planned_exports = [
        export for exports in exports_by_part.values() for export in exports
    ]
    for result in root_results:
        released = result["released"]
        print(
            "Released manufacturing root "
            f"part={released.part_number or '(none)'} "
            f"revision={released.revision or '(unnamed)'} "
            f"version={released.version_id} "
            f"configuration={released.configuration}"
        )
    print(
        f"Onshape rows={sum(len(result['items']) for result in root_results)} "
        f"roots={len(root_results)} parts={len(parts)} "
        f"production_requirements={len(requirements)} "
        f"operations={len(operations)} "
        f"drawings={sum(result['drawing_count'] for result in root_results)} "
        f"pdf_exports={sum(e.field_name == DRAWING_PDF_FIELD for e in planned_exports)} "
        f"step_exports={sum(e.field_name == STEP_FILE_FIELD for e in planned_exports)}"
    )
    for warning in warnings:
        print(f"WARNING: {warning}")

    if dry_run:
        result = {
            "dry_run": True,
            "source_revision": root_results[0]["released"].as_dict(),
            "source_revisions": [
                root["released"].as_dict() for root in root_results
            ],
            "master_baseline_revision": (
                master_released.as_dict() if master_released else None
            ),
            "master_baseline_assemblies": master_revisions,
            "master_workspace_url": discovery_master_url or None,
            "master_workspace_rows": len(master_workspace_items),
            "source_rows": sum(len(root["items"]) for root in root_results),
            "assemblies": assembly_records,
            "parts": parts,
            "requirements": [
                {
                    key: value
                    for key, value in requirement.items()
                    if key != "_operation_machines"
                }
                for requirement in requirements
            ],
            "operations": [
                {
                    key: value
                    for key, value in operation.items()
                    if key != "production_key"
                }
                for operation in operations
            ],
            "file_exports": {
                part_number: [
                    {
                        "field": export.field_name,
                        "filename": export.filename,
                        "source_key": export.source_key,
                    }
                    for export in exports
                ]
                for part_number, exports in sorted(exports_by_part.items())
            },
            "warnings": warnings,
        }
        print("DRY RUN: no Baserow API calls were made")
        if output_json:
            destination = Path(output_json)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(
                json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            print(f"Dry-run JSON written to {destination}")
        return result

    if output_json:
        raise ValueError("--output-json is only available with --dry-run")
    summary = sync_to_baserow(
        parts,
        requirements,
        warnings,
        source_rows=sum(len(root["items"]) for root in root_results),
        exports_by_part=exports_by_part,
        sync_cad_files=sync_cad_files,
        operations=operations,
        assembly_records=assembly_records,
        synced_roots=seen_roots,
        discovery_master=discovery_master_url,
    )
    print(json.dumps(summary, indent=2))
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=environment_flag("DRY_RUN"),
        help="resolve the released BOM and build records without calling Baserow",
    )
    parser.add_argument(
        "--output-json",
        default=os.environ.get("DRY_RUN_OUTPUT", "").strip(),
        metavar="PATH",
        help="write dry-run source revision, parts, and requirements to PATH",
    )
    args = parser.parse_args(argv)

    use_subassembly_list = environment_flag("USE_SUBASSEMBLY_LIST")
    if use_subassembly_list:
        sync_targets = parse_onshape_doc_urls(
            require_env("ONSHAPE_SUBASSEMBLY_URLS")
        )
    else:
        sync_targets = parse_onshape_doc_url(require_env("ONSHAPE_DOC_URL"))
    prefixes = [
        p.strip()
        for p in os.environ.get("PARTNUMBER_PREFIXES", "").split(",")
        if p.strip()
    ]
    reset_onshape_call_counts()
    try:
        run_sync(
            sync_targets,
            prefixes,
            dry_run=args.dry_run,
            output_json=args.output_json,
            sync_cad_files=environment_flag("SYNC_CAD_FILES"),
            discover_from_master=not use_subassembly_list,
        )
    finally:
        print("Onshape API calls: " + json.dumps(onshape_call_summary(), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
