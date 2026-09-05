import importlib.util
import json
import os
from dataclasses import replace
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("OnshapeToBaserow.py")
sys.modules.setdefault("requests", types.ModuleType("requests"))
SPEC = importlib.util.spec_from_file_location("onshape_to_baserow", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def source(url, indent=1):
    return {"viewHref": url, "indentLevel": indent}


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class RejectingResponse(FakeResponse):
    def raise_for_status(self):
        raise RuntimeError("400 Bad Request")


DID = "a" * 24
WID = "b" * 24
EID = "c" * 24
VID_A = "d" * 24
VID_B = "e" * 24
RELEASE_DID = "f" * 24
RELEASE_EID = "9" * 24


def v16_bom_response():
    headers = [
        {"id": "100000000000000000000001", "name": "Item", "propertyName": "item", "valueType": "STRING", "visible": True},
        {"id": "100000000000000000000002", "name": "Quantity", "propertyName": "quantity", "valueType": "QUANTITY", "visible": True},
        {"id": "57f3fb8efa3416c06701d600", "name": "Name", "propertyName": "name", "valueType": "STRING", "visible": True},
        {"id": "57f3fb8efa3416c06701d601", "name": "Description", "propertyName": "description", "valueType": "STRING", "visible": True},
        {"id": "57f3fb8efa3416c06701d602", "name": "Part number", "propertyName": "partNumber", "valueType": "STRING", "visible": True},
        {"id": "57f3fb8efa3416c06701d603", "name": "Revision", "propertyName": "revision", "valueType": "STRING", "visible": True},
        {"id": "57f3fb8efa3416c06701d604", "name": "State", "propertyName": "state", "valueType": "STRING", "visible": True},
        {"id": "57f3fb8efa3416c06701d605", "name": "Material", "propertyName": "material", "valueType": "OBJECT", "visible": True},
        {"id": "67f3fb8efa3416c06701d606", "name": "Manufacturing Method", "propertyName": "manufacturingmethod", "valueType": "STRING", "visible": True},
        {"id": "67f3fb8efa3416c06701d607", "name": "Vendor", "propertyName": "vendor", "valueType": "STRING", "visible": True},
        {"id": "67f3fb8efa3416c06701d608", "name": "Category", "propertyName": "category", "valueType": "STRING", "visible": True},
    ]

    def values(**properties):
        by_property = {header["propertyName"]: header["id"] for header in headers}
        return {by_property[name]: value for name, value in properties.items()}

    return {
        "bomSource": {"documentId": RELEASE_DID, "elementId": RELEASE_EID},
        "formatVersion": "2.0",
        "headers": headers,
        "rows": [
            {
                "rowId": "assembly-row",
                "name": "resource-name-is-not-the-bom-name",
                "indentLevel": 0,
                "itemSource": {
                    "configuration": "default",
                    "documentId": RELEASE_DID,
                    "elementId": RELEASE_EID,
                    "viewHref": "https://cad.onshape.com/documents/root/v/version/e/assembly",
                    "wvmId": VID_B,
                    "wvmType": "v",
                },
                "headerIdToValue": values(
                    item="1",
                    quantity=1,
                    name="A-190B-260001",
                    description="Released subassembly",
                    partNumber="N/A",
                    revision="B",
                    state="RELEASED",
                ),
            },
            {
                "rowId": "matching-part-row",
                "indentLevel": 1,
                "itemSource": {
                    "configuration": "width=0.5+meter",
                    "documentId": "1" * 24,
                    "elementId": "2" * 24,
                    "partId": "JHD",
                    "viewHref": "https://cad.onshape.com/documents/part/v/version/e/studio",
                    "wvmId": "3" * 24,
                    "wvmType": "v",
                },
                "headerIdToValue": values(
                    item="1.2",
                    quantity=2,
                    name="ROLLER PLATE",
                    description="Configured released plate",
                    partNumber="P-190B-260100",
                    revision="C",
                    state="RELEASED",
                    material={"displayName": "Aluminum - 6061"},
                    manufacturingmethod="Haas CNC",
                    vendor="FRC 190",
                    category="Fabricated",
                ),
            },
            {
                "rowId": "nonmatching-part-row",
                "indentLevel": 1,
                "itemSource": {
                    "configuration": "default",
                    "viewHref": "https://cad.onshape.com/documents/cots/v/version/e/studio",
                },
                "headerIdToValue": values(
                    item="1.3",
                    quantity=4,
                    name="BEARING",
                    partNumber="COTS-0001",
                    revision="A",
                    state="RELEASED",
                ),
            },
        ],
    }


def target(configuration="default"):
    return MODULE.OnshapeTarget(
        "https://cad.onshape.com", DID, "w", WID, EID, configuration
    )


def revision(revision_name, version_id, **overrides):
    item = {
        "id": f"revision-{revision_name}",
        "documentId": DID,
        "elementId": EID,
        "elementType": 1,
        "configuration": "default",
        "revision": revision_name,
        "partNumber": "A-190B-260001",
        "name": "Robot",
        "versionId": version_id,
        "releaseCreatedDate": f"2026-01-0{1 if revision_name == 'A' else 2}T00:00:00Z",
        "nextRevisionId": None,
    }
    item.update(overrides)
    return item


def drawing_revision(part_number, document_id, version_id, element_id, **overrides):
    item = {
        "documentId": document_id,
        "elementId": element_id,
        "elementType": MODULE.DRAWING_ELEMENT_TYPE,
        "partNumber": part_number,
        "revision": "A",
        "versionId": version_id,
    }
    item.update(overrides)
    return item


class OnshapeCallTelemetryTests(unittest.TestCase):
    def tearDown(self):
        MODULE.reset_onshape_call_counts()

    def test_request_wrapper_counts_calls_by_endpoint_category(self):
        MODULE.reset_onshape_call_counts()
        document_id = "1" * 24
        url = f"https://cad.onshape.com/api/v16/revisions/d/{document_id}"

        with patch.object(
            MODULE.requests,
            "get",
            return_value=FakeResponse({"items": []}),
            create=True,
        ), patch.object(MODULE, "onshape_headers", return_value={}):
            MODULE.onshape_get_json(url)

        MODULE.record_onshape_call(
            "GET",
            f"https://cad.onshape.com/api/v16/metadata/d/{document_id}/v/"
            f"{'2' * 24}/e/{'3' * 24}/p?thumbnail=false",
        )
        MODULE.record_onshape_call(
            "GET",
            f"https://cad.onshape.com/api/v16/assemblies/d/{document_id}/v/"
            f"{'2' * 24}/e/{'3' * 24}/bom",
        )

        self.assertEqual(
            MODULE.onshape_call_summary(),
            {
                "total": 3,
                "by_category": {
                    "bom": 1,
                    "document_revisions": 1,
                    "part_metadata_bulk": 1,
                },
            },
        )


class ReleaseResolutionTests(unittest.TestCase):
    def test_document_url_preserves_configuration(self):
        parsed = MODULE.parse_onshape_doc_url(
            f"https://cad.onshape.com/documents/{DID}/w/{WID}/e/{EID}"
            "?configuration=size%3DLarge%2Blength%3D1%2Bmeter"
        )
        self.assertEqual(parsed.wvm_type, "w")
        self.assertEqual(parsed.configuration, "size=Large+length=1+meter")

    def test_document_url_list_accepts_newlines_and_commas(self):
        first = f"https://cad.onshape.com/documents/{DID}/w/{WID}/e/{EID}"
        second = (
            f"https://cad.onshape.com/documents/{'1' * 24}/w/"
            f"{'2' * 24}/e/{'3' * 24}"
        )

        parsed = MODULE.parse_onshape_doc_urls(f"{first}\n{second},{first}")

        self.assertEqual(len(parsed), 3)
        self.assertEqual([target.did for target in parsed], [DID, "1" * 24, DID])

    def test_main_uses_subassembly_list_without_master_discovery(self):
        first = f"https://cad.onshape.com/documents/{DID}/w/{WID}/e/{EID}"
        second = (
            f"https://cad.onshape.com/documents/{'1' * 24}/w/"
            f"{'2' * 24}/e/{'3' * 24}"
        )
        environment = {
            "USE_SUBASSEMBLY_LIST": "true",
            "ONSHAPE_SUBASSEMBLY_URLS": f"{first}\n{second}",
            "PARTNUMBER_PREFIXES": "P-190B-26",
            "SYNC_CAD_FILES": "false",
        }

        with patch.dict(os.environ, environment, clear=True), patch.object(
            MODULE, "run_sync"
        ) as run_sync:
            result = MODULE.main([])

        self.assertEqual(result, 0)
        targets = run_sync.call_args.args[0]
        self.assertEqual([target.did for target in targets], [DID, "1" * 24])
        self.assertFalse(run_sync.call_args.kwargs["discover_from_master"])

    def test_main_can_opt_out_to_master_discovery(self):
        master = f"https://cad.onshape.com/documents/{DID}/w/{WID}/e/{EID}"
        environment = {
            "USE_SUBASSEMBLY_LIST": "false",
            "ONSHAPE_DOC_URL": master,
            "PARTNUMBER_PREFIXES": "P-190B-26",
            "SYNC_CAD_FILES": "false",
        }

        with patch.dict(os.environ, environment, clear=True), patch.object(
            MODULE, "run_sync"
        ) as run_sync:
            result = MODULE.main([])

        self.assertEqual(result, 0)
        self.assertEqual(run_sync.call_args.args[0].did, DID)
        self.assertTrue(run_sync.call_args.kwargs["discover_from_master"])

    def test_release_resolution_uses_part_number_and_returned_coordinates(self):
        metadata = {
            "properties": [
                {"name": "Name", "value": "Kicker"},
                {"name": "Part number", "value": "A-26C-0004"},
            ]
        }
        latest = revision(
            "C",
            VID_B,
            documentId=RELEASE_DID,
            elementId=RELEASE_EID,
            partNumber="A-26C-0004",
            configuration="Kicker Position=Free",
        )

        with patch.object(
            MODULE, "onshape_get_json", side_effect=[metadata, latest]
        ) as get_json:
            selected = MODULE.resolve_latest_released_assembly(
                target(configuration="default")
            )

        metadata_url = get_json.call_args_list[0].args[0]
        latest_url = get_json.call_args_list[1].args[0]
        self.assertIn(f"/metadata/d/{DID}/w/{WID}/e/{EID}", metadata_url)
        self.assertNotIn("configuration=", metadata_url)
        self.assertIn(f"/revisions/d/{DID}/p/A-26C-0004/latest", latest_url)
        self.assertIn("et=1", latest_url)
        self.assertEqual(selected.document_id, RELEASE_DID)
        self.assertEqual(selected.element_id, RELEASE_EID)
        self.assertEqual(selected.version_id, VID_B)
        self.assertEqual(selected.configuration, "Kicker Position=Free")

    def test_part_number_is_url_encoded_for_latest_revision_lookup(self):
        with patch.object(MODULE, "onshape_get_json", return_value={}) as get_json:
            MODULE.fetch_latest_assembly_revision(target(), "A 1/2")

        requested_url = get_json.call_args.args[0]
        self.assertIn("/p/A%201%2F2/latest", requested_url)
        self.assertIn("et=1", requested_url)

    def test_no_release_fails_instead_of_falling_back_to_main(self):
        metadata = {"properties": [{"name": "Part number", "value": "A-26C-0004"}]}
        with patch.object(
            MODULE, "onshape_get_json", side_effect=[metadata, {}]
        ), self.assertRaisesRegex(RuntimeError, "immutable version"):
            MODULE.resolve_latest_released_assembly(target())

    def test_missing_workspace_part_number_fails_before_revision_lookup(self):
        with patch.object(
            MODULE,
            "onshape_get_json",
            return_value={"properties": [{"name": "Part number", "value": ""}]},
        ) as get_json, self.assertRaisesRegex(RuntimeError, "no Part number"):
            MODULE.resolve_latest_released_assembly(target())

        self.assertEqual(get_json.call_count, 1)

    def test_master_discovery_resolves_only_direct_released_children(self):
        direct_did = "1" * 24
        nested_did = "2" * 24
        unreleased_did = "3" * 24
        rows = [
            {
                "name": "A-26C-0001",
                "partNumber": "A-190B-261132",
                "indentLevel": 0,
                "itemSource": {
                    "documentId": direct_did,
                    "wvmType": "w",
                    "wvmId": "4" * 24,
                },
            },
            {
                "name": "A-26C-0002",
                "partNumber": "A-190B-261133",
                "indentLevel": 1,
                "itemSource": {
                    "documentId": nested_did,
                    "wvmType": "v",
                    "wvmId": "5" * 24,
                },
            },
            {
                "name": "A-26C-0001",
                "partNumber": "A-190B-261132",
                "indentLevel": 0,
                "itemSource": {
                    "documentId": direct_did,
                    "wvmType": "v",
                    "wvmId": "9" * 24,
                },
            },
            {
                "name": "A-26C-0003",
                "partNumber": "A-190B-261134",
                "indentLevel": 0,
                "itemSource": {
                    "documentId": unreleased_did,
                    "wvmType": "w",
                    "wvmId": "6" * 24,
                },
            },
        ]

        def latest(reference, part_number):
            if part_number == "A-190B-261134":
                return None
            return revision(
                "B",
                "7" * 24,
                documentId=reference.did,
                elementId="8" * 24,
                partNumber=part_number,
            )

        with patch.object(
            MODULE,
            "fetch_latest_discovered_assembly_revision",
            side_effect=latest,
        ) as fetch_latest:
            roots, warnings = MODULE.discover_released_manufacturing_roots(
                target(), rows
            )

        self.assertEqual(
            [root.part_number for _, root in roots], ["A-190B-261132"]
        )
        self.assertEqual(
            {call.args[1] for call in fetch_latest.call_args_list},
            {"A-190B-261132", "A-190B-261134"},
        )
        self.assertTrue(any("A-190B-261134" in warning for warning in warnings))
        self.assertFalse(any("A-190B-261133" in warning for warning in warnings))

    def test_discovered_child_without_release_handles_204(self):
        reference = MODULE.OnshapeDocumentReference(
            "https://frc190.onshape.com", "1" * 24, "w", "2" * 24
        )
        with patch.object(
            MODULE.requests, "get", return_value=FakeResponse(None, 204), create=True
        ) as get, patch.object(MODULE, "onshape_headers", return_value={}):
            latest = MODULE.fetch_latest_discovered_assembly_revision(
                reference, "A-190B-261132"
            )

        self.assertIsNone(latest)
        self.assertIn("/p/A-190B-261132/latest?et=1", get.call_args.args[0])

    def test_bom_is_fetched_from_immutable_released_version(self):
        released = MODULE.released_assembly_from_revision(
            revision(
                "B",
                VID_B,
                documentId=RELEASE_DID,
                elementId=RELEASE_EID,
                configuration="Kicker Position=Free",
            )
        )
        response = FakeResponse({"bomTable": {"items": [{"partNumber": "P-190B-260001"}]}})

        with patch.object(MODULE, "onshape_headers", return_value={}), patch.object(
            MODULE.requests, "get", return_value=response, create=True
        ) as get:
            rows = MODULE.fetch_bom(released.bom_target("https://cad.onshape.com"))

        requested_url = get.call_args.args[0]
        self.assertIn(
            f"/assemblies/d/{RELEASE_DID}/v/{VID_B}/e/{RELEASE_EID}/bom",
            requested_url,
        )
        self.assertNotIn(f"/w/{WID}/", requested_url)
        self.assertIn("configuration=Kicker+Position%3DFree", requested_url)
        self.assertEqual(rows[0]["partNumber"], "P-190B-260001")

    def test_master_workspace_discovery_generates_bom_if_absent(self):
        response = FakeResponse(
            {"bomTable": {"items": [{"name": "A-DIRECT", "partNumber": "N/A"}]}}
        )
        with patch.object(MODULE, "onshape_headers", return_value={}), patch.object(
            MODULE.requests, "get", return_value=response, create=True
        ) as get:
            rows = MODULE.fetch_bom(target(), generate_if_absent=True)

        self.assertIn("generateIfAbsent=true", get.call_args.args[0])
        self.assertEqual(rows[0]["name"], "A-DIRECT")

    def test_v16_bom_headers_and_rows_are_normalized(self):
        payload = v16_bom_response()
        with patch.object(MODULE, "onshape_get_json", return_value=payload):
            rows = MODULE.fetch_bom(target())

        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["name"], "A-190B-260001")
        self.assertEqual(rows[1]["partNumber"], "P-190B-260100")
        self.assertEqual(rows[1]["quantity"], 2)
        self.assertEqual(rows[1]["revision"], "C")
        self.assertEqual(rows[1]["state"], "RELEASED")
        self.assertEqual(rows[1]["indentLevel"], 1)
        self.assertEqual(
            rows[1]["itemSource"], payload["rows"][1]["itemSource"]
        )
        self.assertNotIn("headerIdToValue", rows[1])

    def test_v16_dry_run_json_contains_matching_parts_and_requirements(self):
        released = MODULE.released_assembly_from_revision(revision("B", VID_B))
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "dry-run.json"
            with patch.object(
                MODULE, "resolve_latest_released_assembly", return_value=released
            ), patch.object(
                MODULE, "onshape_get_json", return_value=v16_bom_response()
            ), patch.object(
                MODULE,
                "drawing_urls_for_parts",
                return_value=(
                    {
                        "P-190B-260100": (
                            f"https://cad.onshape.com/documents/{'4' * 24}/v/"
                            f"{'5' * 24}/e/{'6' * 24}"
                        )
                    },
                    [],
                ),
            ), patch.object(
                MODULE,
                "fetch_parts_metadata",
                return_value={"items": [{"partId": "JHD", "properties": []}]},
            ), patch.object(
                MODULE,
                "fetch_document_metadata",
                return_value={"name": "A-26C-0001"},
            ), patch.object(
                MODULE, "sync_to_baserow", side_effect=AssertionError("Baserow called")
            ):
                MODULE.run_sync(
                    target(),
                    ["P-190B-26"],
                    dry_run=True,
                    output_json=str(output),
                    sync_cad_files=True,
                )
            saved = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(saved["source_rows"], 3)
        self.assertEqual(
            [part["Part Number"] for part in saved["parts"]],
            ["P-190B-260100"],
        )
        self.assertEqual(saved["parts"][0]["Revision"], "C")
        self.assertEqual(saved["parts"][0]["OnShape Text"], "RELEASED")
        self.assertEqual(saved["parts"][0]["Material"], "Aluminum - 6061")
        self.assertEqual(
            saved["parts"][0]["Onshape Drawing"],
            f"https://cad.onshape.com/documents/{'4' * 24}/v/"
            f"{'5' * 24}/e/{'6' * 24}",
        )
        self.assertEqual(len(saved["requirements"]), 1)
        self.assertEqual(saved["requirements"][0]["assembly_number"], "A-190B-260001")
        self.assertEqual(saved["requirements"][0]["Configuration"], "width=0.5+meter")
        self.assertEqual(saved["requirements"][0]["Required Quantity"], 2)
        self.assertEqual(saved["requirements"][0]["BOM Positions"], "1.2")
        self.assertEqual(
            saved["requirements"][0]["Source Document"], "A-26C-0001"
        )
        self.assertEqual(len(saved["assemblies"]), 1)
        self.assertEqual(
            saved["assemblies"][0]["Assembly Number"], "A-190B-260001"
        )
        self.assertEqual(
            saved["assemblies"][0]["Integration Status"], "Not Compared"
        )
        self.assertEqual(len(saved["operations"]), 1)
        self.assertEqual(saved["operations"][0]["Operation Number"], "OP1")
        self.assertEqual(saved["operations"][0]["Machine"], "Haas CNC")
        self.assertEqual(
            {export["field"] for export in saved["file_exports"]["P-190B-260100"]},
            {MODULE.DRAWING_PDF_FIELD, MODULE.STEP_FILE_FIELD},
        )

    def test_dry_run_writes_records_without_baserow(self):
        released = MODULE.released_assembly_from_revision(revision("B", VID_B))
        rows = [
            {"name": "A-190B-260001", "partNumber": "", "itemSource": source("", 0)},
            {
                "item": "1.1",
                "quantity": "2",
                "partNumber": "P-190B-260100",
                "name": "PLATE",
                "revision": "C",
                "itemSource": source("https://cad.onshape.com/documents/child/v/version/e/element", 1),
            },
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "dry-run.json"
            with patch.object(
                MODULE, "resolve_latest_released_assembly", return_value=released
            ), patch.object(MODULE, "fetch_bom", return_value=rows), patch.object(
                MODULE, "drawing_urls_for_parts", return_value=({}, [])
            ), patch.object(
                MODULE, "sync_to_baserow", side_effect=AssertionError("Baserow called")
            ):
                result = MODULE.run_sync(
                    target(), ["P-190B-26"], dry_run=True, output_json=str(output)
                )

            saved = json.loads(output.read_text(encoding="utf-8"))
        self.assertTrue(result["dry_run"])
        self.assertEqual(saved["source_revision"]["version_id"], VID_B)
        self.assertEqual(saved["parts"][0]["Revision"], "C")
        self.assertEqual(saved["requirements"][0]["Required Quantity"], 2)


class SourceDocumentTests(unittest.TestCase):
    def test_document_metadata_uses_get_document_endpoint(self):
        document_id = "1" * 24
        with patch.object(
            MODULE,
            "onshape_get_json",
            return_value={"id": document_id, "name": "A-26C-0001"},
        ) as get_json:
            metadata = MODULE.fetch_document_metadata(
                "https://frc190.onshape.com", document_id
            )

        self.assertEqual(metadata["name"], "A-26C-0001")
        get_json.assert_called_once_with(
            f"https://frc190.onshape.com/api/v16/documents/{document_id}"
        )

    def test_names_propagate_and_metadata_is_cached_per_document(self):
        shared_did = "1" * 24
        other_did = "2" * 24
        other_vid = "3" * 24
        other_eid = "4" * 24
        rows = [
            {
                "item": "1",
                "quantity": 1,
                "partNumber": "P-190B-260101",
                "itemSource": {"documentId": shared_did},
            },
            {
                "item": "2",
                "quantity": 1,
                "partNumber": "P-190B-260102",
                "itemSource": {"documentId": shared_did},
            },
            {
                "item": "3",
                "quantity": 1,
                "partNumber": "P-190B-260103",
                "itemSource": {
                    "viewHref": (
                        f"https://frc190.onshape.com/documents/{other_did}/v/"
                        f"{other_vid}/e/{other_eid}"
                    )
                },
            },
        ]

        def metadata_for(_base_url, document_id):
            return {
                "name": (
                    "A-26C-0001"
                    if document_id == shared_did
                    else "A-26C-0002"
                )
            }

        with patch.object(
            MODULE, "fetch_document_metadata", side_effect=metadata_for
        ) as fetch_metadata:
            names, warnings = MODULE.source_document_names_for_rows(
                rows, ["P-190B-26"], "https://cad.onshape.com"
            )
        _, requirements, build_warnings = MODULE.build_records(
            rows,
            ["P-190B-26"],
            source_document_names=names,
        )

        self.assertEqual(fetch_metadata.call_count, 2)
        self.assertEqual(
            [call.args[1] for call in fetch_metadata.call_args_list],
            [shared_did, other_did],
        )
        by_part = {
            requirement["part_number"]: requirement["Source Document"]
            for requirement in requirements
        }
        self.assertEqual(by_part["P-190B-260101"], "A-26C-0001")
        self.assertEqual(by_part["P-190B-260102"], "A-26C-0001")
        self.assertEqual(by_part["P-190B-260103"], "A-26C-0002")
        self.assertEqual(warnings, [])
        self.assertEqual(build_warnings, [])

    def test_missing_source_and_unavailable_metadata_warn_without_failing(self):
        unavailable_did = "5" * 24
        rows = [
            {
                "item": "1",
                "quantity": 1,
                "partNumber": "P-190B-260201",
            },
            {
                "item": "2",
                "quantity": 1,
                "partNumber": "P-190B-260202",
                "itemSource": {"documentId": unavailable_did},
            },
            {
                "item": "3",
                "quantity": 1,
                "partNumber": "P-190B-260203",
                "itemSource": {"documentId": unavailable_did},
            },
        ]

        with patch.object(
            MODULE,
            "fetch_document_metadata",
            side_effect=RuntimeError("document access denied"),
        ) as fetch_metadata:
            names, warnings = MODULE.source_document_names_for_rows(
                rows, ["P-190B-26"], "https://cad.onshape.com"
            )
        _, requirements, _ = MODULE.build_records(
            rows,
            ["P-190B-26"],
            source_document_names=names,
        )

        self.assertEqual(fetch_metadata.call_count, 1)
        self.assertEqual(names, {})
        self.assertTrue(
            all(requirement["Source Document"] == "" for requirement in requirements)
        )
        for part_number in (
            "P-190B-260201",
            "P-190B-260202",
            "P-190B-260203",
        ):
            self.assertTrue(
                any(part_number in warning for warning in warnings),
                warnings,
            )


class DrawingLinkTests(unittest.TestCase):
    def test_document_revisions_are_cached_and_newest_drawing_is_selected(self):
        part_did = "1" * 24
        part_vid = "2" * 24
        item_source = {
            "documentId": part_did,
            "wvmType": "v",
            "wvmId": part_vid,
            "viewHref": (
                f"https://cad.onshape.com/documents/{part_did}/v/{part_vid}/e/"
                f"{'3' * 24}"
            ),
        }
        rows = [
            {
                "partNumber": "P-190B-260100",
                "itemSource": item_source,
            },
            {
                "partNumber": "P-190B-260100",
                "itemSource": {**item_source, "configuration": "Length=2+inch"},
            },
        ]
        older = drawing_revision(
            "P-190B-260100", part_did, "6" * 24, "7" * 24,
            releaseCreatedDate="2026-01-01T00:00:00Z",
        )
        newest = drawing_revision(
            "P-190B-260100", part_did, "8" * 24, "9" * 24,
            releaseCreatedDate="2026-02-01T00:00:00Z",
        )
        with patch.object(
            MODULE, "fetch_document_revisions", return_value={"items": [newest, older]}
        ) as fetch_revisions:
            drawing_urls, warnings = MODULE.drawing_urls_for_parts(
                rows, ["P-190B-26"], "https://cad.onshape.com"
            )

        self.assertEqual(fetch_revisions.call_count, 1)
        self.assertEqual(warnings, [])
        self.assertEqual(
            drawing_urls["P-190B-260100"],
            f"https://cad.onshape.com/documents/{part_did}/v/{'8' * 24}/e/"
            f"{'9' * 24}",
        )

    def test_released_assembly_document_is_included_as_drawing_source(self):
        released_reference = MODULE.OnshapeDocumentReference(
            "https://frc190.onshape.com", "3" * 24, "v", "4" * 24
        )
        rows = [
            {
                "partNumber": "P-190B-260764",
                "itemSource": None,
            }
        ]
        latest = drawing_revision(
            "P-190B-260764", "6" * 24, "7" * 24, "8" * 24
        )
        with patch.object(
            MODULE, "fetch_document_revisions", return_value={"items": [latest]}
        ):
            drawing_urls, warnings = MODULE.drawing_urls_for_parts(
                rows,
                ["P-190B-26"],
                "https://frc190.onshape.com",
                [released_reference],
            )

        self.assertEqual(warnings, [])
        self.assertEqual(
            drawing_urls["P-190B-260764"],
            f"https://frc190.onshape.com/documents/{'6' * 24}/"
            f"v/{'7' * 24}/e/{'8' * 24}",
        )

    def test_multiple_matching_drawings_warn_and_leave_link_blank(self):
        first_did = "1" * 24
        second_did = "2" * 24
        rows = [
            {
                "partNumber": "P-190B-260100",
                "itemSource": {
                    "documentId": first_did,
                    "wvmType": "v",
                    "wvmId": "3" * 24,
                },
            },
            {
                "partNumber": "P-190B-260100",
                "itemSource": {
                    "documentId": second_did,
                    "wvmType": "v",
                    "wvmId": "4" * 24,
                },
            },
        ]
        def revisions_for(base_url, document_id):
            return {
                "items": [
                    drawing_revision(
                        "P-190B-260100",
                        document_id,
                        "6" * 24 if document_id == first_did else "7" * 24,
                        "8" * 24 if document_id == first_did else "9" * 24,
                    )
                ]
            }

        with patch.object(
            MODULE, "fetch_document_revisions", side_effect=revisions_for
        ) as fetch_revisions:
            drawing_urls, warnings = MODULE.drawing_urls_for_parts(
                rows, ["P-190B-26"], "https://cad.onshape.com"
            )

        self.assertEqual(fetch_revisions.call_count, 2)
        self.assertNotIn("P-190B-260100", drawing_urls)
        self.assertEqual(len(warnings), 1)
        self.assertIn("Multiple released drawings", warnings[0])

    def test_revision_cache_is_shared_across_root_calls(self):
        document_id = "1" * 24
        rows = [
            {
                "partNumber": "P-190B-260764",
                "itemSource": {
                    "documentId": document_id,
                    "wvmType": "v",
                    "wvmId": "2" * 24,
                },
            }
        ]
        payload = {
            "items": [
                drawing_revision(
                    "P-190B-260764", document_id, "6" * 24, "7" * 24
                )
            ]
        }
        cache = {}
        with patch.object(
            MODULE, "fetch_document_revisions", return_value=payload
        ) as fetch_revisions:
            first = MODULE.drawing_urls_for_parts(
                rows, ["P-190B-26"], "https://frc190.onshape.com",
                revision_cache=cache,
            )
            second = MODULE.drawing_urls_for_parts(
                rows, ["P-190B-26"], "https://frc190.onshape.com",
                revision_cache=cache,
            )

        self.assertEqual(fetch_revisions.call_count, 1)
        self.assertEqual(first, second)

    def test_unreleased_drawing_is_not_used_as_pdf_source(self):
        part_number = "P-190B-260100"
        rows = [
            {
                "partNumber": part_number,
                "itemSource": {
                    "documentId": "1" * 24,
                    "wvmType": "w",
                    "wvmId": "2" * 24,
                },
            }
        ]
        with patch.object(
            MODULE, "fetch_document_revisions", return_value={"items": []}
        ):
            drawing_urls, warnings = MODULE.drawing_urls_for_parts(
                rows, ["P-190B-26"], "https://cad.onshape.com"
            )

        self.assertNotIn(part_number, drawing_urls)
        self.assertEqual(len(warnings), 1)
        self.assertIn("No released drawing revision", warnings[0])

    def test_latest_drawing_revision_uses_drawing_type_and_handles_204(self):
        reference = MODULE.OnshapeDocumentReference(
            "https://frc190.onshape.com", "1" * 24, "v", "2" * 24
        )
        with patch.object(
            MODULE.requests, "get", return_value=FakeResponse(None, 204), create=True
        ) as get, patch.object(MODULE, "onshape_headers", return_value={}):
            latest = MODULE.fetch_latest_drawing_revision(
                reference, "P-190B-260100"
            )

        self.assertIsNone(latest)
        self.assertIn("/p/P-190B-260100/latest?et=2", get.call_args.args[0])


class FileExportTests(unittest.TestCase):
    def sample_export(self, field=MODULE.STEP_FILE_FIELD):
        return MODULE.FileExport(
            part_number="P-190B-260100",
            field_name=field,
            key_field_name=(
                MODULE.STEP_KEY_FIELD
                if field == MODULE.STEP_FILE_FIELD
                else MODULE.DRAWING_PDF_KEY_FIELD
            ),
            source_key="source-key",
            filename="P-190B-260100_rev-C.step",
            content_type="application/step",
            endpoint=(
                f"https://cad.onshape.com/api/v16/partstudios/d/{DID}/v/"
                f"{VID_B}/e/{EID}/translations"
            ),
            request_body={"formatName": "STEP"},
            source_document_id=DID,
        )

    def test_build_file_exports_targets_one_part_and_its_configuration(self):
        rows = v16_bom_response()["rows"]
        normalized = MODULE.normalize_bom_rows(
            v16_bom_response()["headers"], rows
        )
        parts, _, _ = MODULE.build_records(normalized, ["P-190B-26"])
        drawing_url = (
            f"https://cad.onshape.com/documents/{'4' * 24}/v/"
            f"{'5' * 24}/e/{'6' * 24}"
        )

        exports, warnings = MODULE.build_file_exports(
            parts,
            normalized,
            {"P-190B-260100": drawing_url},
            ["P-190B-26"],
            "https://cad.onshape.com",
        )

        self.assertEqual(warnings, [])
        by_field = {export.field_name: export for export in exports["P-190B-260100"]}
        step = by_field[MODULE.STEP_FILE_FIELD]
        self.assertIn("/partstudios/d/", step.endpoint)
        self.assertEqual(step.request_body["partIds"], "JHD")
        self.assertEqual(step.request_body["configuration"], "width=0.5+meter")
        self.assertFalse(step.request_body["storeInDocument"])
        self.assertTrue(step.request_body["evaluateExportRule"])
        pdf = by_field[MODULE.DRAWING_PDF_FIELD]
        self.assertIn("/drawings/d/", pdf.endpoint)
        self.assertEqual(pdf.request_body["formatName"], "PDF")
        self.assertTrue(pdf.request_body["evaluateExportRule"])

    def test_step_exports_are_limited_to_configured_manufacturing_methods(self):
        allowed = (
            "Haas CNC",
            "Shop Sabre CNC",
            "Bambu 3D Printer",
            "Markforged 3D Printer",
            "FormLabs SLA",
            "FormLabs SLS",
        )
        for method in allowed:
            with self.subTest(method=method):
                self.assertTrue(
                    MODULE.step_export_enabled({"Manufacturing Method": method})
                )
        for method in ("Lathe", "Bandsaw", "COTS", "", None):
            with self.subTest(method=method):
                self.assertFalse(
                    MODULE.step_export_enabled({"Manufacturing Method": method})
                )

    def test_unlisted_method_does_not_plan_or_warn_about_step_export(self):
        normalized = MODULE.normalize_bom_rows(
            v16_bom_response()["headers"], v16_bom_response()["rows"]
        )
        parts, _, _ = MODULE.build_records(normalized, ["P-190B-26"])
        parts[0]["Manufacturing Method"] = "Lathe"

        exports, warnings = MODULE.build_file_exports(
            parts,
            normalized,
            {},
            ["P-190B-26"],
            "https://cad.onshape.com",
        )

        self.assertEqual(exports, {})
        self.assertEqual(warnings, [])

    def test_current_file_and_export_key_skip_translation(self):
        export = self.sample_export()
        expected_key = MODULE.aggregate_export_key([export])
        parts = [{"Part Number": export.part_number}]
        existing = [
            {
                "Part Number": export.part_number,
                MODULE.STEP_FILE_FIELD: [{"name": "stored-step"}],
                MODULE.STEP_KEY_FIELD: expected_key,
            }
        ]

        with patch.object(
            MODULE,
            "start_file_translation",
            side_effect=AssertionError("translation started"),
        ):
            uploaded, cached = MODULE.attach_exported_files(
                object(), parts, existing, {export.part_number: [export]}, []
            )

        self.assertEqual((uploaded, cached), (0, 1))
        self.assertEqual(parts[0][MODULE.STEP_FILE_FIELD], [{"name": "stored-step"}])

    def test_changed_export_is_downloaded_and_uploaded(self):
        export = self.sample_export()
        parts = [{"Part Number": export.part_number}]
        warnings = []

        class Client:
            def upload_file(self, filename, content, content_type):
                self.upload = (filename, content, content_type)
                return {"name": "baserow-file-name"}

        client = Client()
        with patch.object(
            MODULE, "start_file_translation", return_value={"id": "translation"}
        ), patch.object(
            MODULE,
            "wait_for_translation",
            return_value={
                "resultExternalDataIds": ["external"],
                "exportRuleFileName": "Configured Shop Export",
            },
        ), patch.object(MODULE, "download_translation", return_value=b"STEP"):
            uploaded, cached = MODULE.attach_exported_files(
                client, parts, [], {export.part_number: [export]}, warnings
            )

        self.assertEqual((uploaded, cached), (1, 0))
        self.assertEqual(warnings, [])
        self.assertEqual(
            parts[0][MODULE.STEP_FILE_FIELD], [{"name": "baserow-file-name"}]
        )
        self.assertEqual(
            parts[0][MODULE.STEP_KEY_FIELD], MODULE.aggregate_export_key([export])
        )
        self.assertEqual(client.upload[0], "Configured Shop Export.step")
        self.assertEqual(client.upload[1], b"STEP")

    def test_failed_refresh_does_not_clear_the_previous_attachment(self):
        export = self.sample_export()
        parts = [{"Part Number": export.part_number}]
        existing = [
            {
                "Part Number": export.part_number,
                MODULE.STEP_FILE_FIELD: [{"name": "previous"}],
                MODULE.STEP_KEY_FIELD: "old-key",
            }
        ]
        warnings = []

        with patch.object(
            MODULE, "start_file_translation", side_effect=RuntimeError("denied")
        ):
            uploaded, cached = MODULE.attach_exported_files(
                object(), parts, existing, {export.part_number: [export]}, warnings
            )

        self.assertEqual((uploaded, cached), (0, 0))
        self.assertEqual(parts[0][MODULE.STEP_FILE_FIELD], [{"name": "previous"}])
        self.assertEqual(parts[0][MODULE.STEP_KEY_FIELD], "old-key")
        self.assertIn("Could not start STEP File export", warnings[0])

    def test_multiple_file_values_can_be_compared(self):
        existing = {
            MODULE.STEP_FILE_FIELD: [
                {"name": "second", "url": "https://files/second"},
                {"name": "first", "url": "https://files/first"},
            ]
        }
        desired = {
            MODULE.STEP_FILE_FIELD: [
                {"name": "first"},
                {"name": "second"},
            ]
        }

        self.assertFalse(
            MODULE.changed(
                existing, desired, (MODULE.STEP_FILE_FIELD,)
            )
        )


class RecordBuildingTests(unittest.TestCase):
    def test_every_baserow_machine_name_is_normalized_case_insensitively(self):
        for machine in MODULE.BASEROW_MACHINE_NAMES:
            with self.subTest(machine=machine):
                self.assertEqual(
                    MODULE.operation_machine_name(machine.swapcase()), machine
                )

    def test_requirement_machine_fields_use_exact_baserow_choice_casing(self):
        fields = MODULE.production_requirement_machine_fields(
            {
                "Manufacturing Method": "countersinking",
                "Manufacturing Method OP2": "Threaded insert",
                "Manufacturing Method OP3": "threaded insert",
                "Manufacturing Method OP4": "NONE",
            }
        )

        self.assertEqual(
            fields,
            {
                "Machine OP1": "Countersinking",
                "Machine OP2": "Threaded Insert",
                "Machine OP3": "Threaded Insert",
                "Machine OP4": None,
            },
        )

    def test_part_operation_metadata_uses_immutable_configured_source_and_cache(self):
        item_source = {
            "documentId": "1" * 24,
            "wvmType": "v",
            "wvmId": "2" * 24,
            "elementId": "3" * 24,
            "partId": "JHD",
            "configuration": "Length=2+inch",
        }
        rows = [
            {
                "partNumber": "P-190B-260100",
                "itemSource": item_source,
            },
            {
                "partNumber": "P-190B-260100",
                "itemSource": item_source,
            },
        ]
        metadata = {
            "properties": [
                {"name": "manufacturing method", "value": "HAAS CNC"},
                {"name": "Manufacturing Method OP2", "value": "ShopSabre"},
                {"name": "Powder Coat Color", "value": "Red"},
            ]
        }

        with patch.object(
            MODULE,
            "fetch_parts_metadata",
            return_value={"items": [{"partId": "JHD", **metadata}]},
        ) as fetch_metadata, patch.object(
            MODULE,
            "fetch_part_metadata",
            side_effect=AssertionError("single-part fallback used"),
        ):
            hydrated = MODULE.hydrate_operation_properties(
                rows, ["P-190B-26"], "https://frc190.onshape.com"
            )

        self.assertEqual(fetch_metadata.call_count, 1)
        self.assertEqual(
            MODULE.operation_machines_from_row(hydrated[0]),
            (("OP1", "Haas CNC"), ("OP2", "Shop Sabre CNC")),
        )
        self.assertEqual(hydrated[0]["Powder Coat Color"], "Red")

    def test_missing_bulk_part_uses_cached_single_part_fallback(self):
        item_source = {
            "documentId": "1" * 24,
            "wvmType": "v",
            "wvmId": "2" * 24,
            "elementId": "3" * 24,
            "partId": "JHD",
            "configuration": "default",
        }
        rows = [
            {"partNumber": "P-190B-260100", "itemSource": item_source},
            {"partNumber": "P-190B-260100", "itemSource": item_source},
        ]
        metadata = {
            "properties": [
                {"name": "Manufacturing Method", "value": "HAAS CNC"}
            ]
        }

        with patch.object(
            MODULE, "fetch_parts_metadata", return_value={"items": []}
        ) as fetch_bulk, patch.object(
            MODULE, "fetch_part_metadata", return_value=metadata
        ) as fetch_single:
            hydrated = MODULE.hydrate_operation_properties(
                rows, ["P-190B-26"], "https://frc190.onshape.com"
            )

        self.assertEqual(fetch_bulk.call_count, 1)
        self.assertEqual(fetch_single.call_count, 1)
        self.assertEqual(hydrated[0]["Manufacturing Method"], "HAAS CNC")
        self.assertEqual(hydrated[1]["Manufacturing Method"], "HAAS CNC")

    def test_part_metadata_request_includes_configuration(self):
        item_source = {
            "documentId": "1" * 24,
            "wvmType": "v",
            "wvmId": "2" * 24,
            "elementId": "3" * 24,
            "partId": "JHD",
            "configuration": "Length=2+inch",
        }
        with patch.object(
            MODULE, "onshape_get_json", return_value={"properties": []}
        ) as get:
            MODULE.fetch_part_metadata(item_source, "https://frc190.onshape.com")

        url = get.call_args.args[0]
        self.assertIn("/metadata/d/", url)
        self.assertIn("/e/" + "3" * 24 + "/p/JHD", url)
        self.assertIn("configuration=Length%3D2%2Binch", url)

    def test_bulk_part_metadata_request_includes_configuration(self):
        reference = MODULE.OnshapeDocumentReference(
            "https://frc190.onshape.com", "1" * 24, "v", "2" * 24
        )
        with patch.object(
            MODULE, "onshape_get_json", return_value={"items": []}
        ) as get:
            MODULE.fetch_parts_metadata(
                reference, "3" * 24, "Length=2+inch"
            )

        url = get.call_args.args[0]
        self.assertIn("/e/" + "3" * 24 + "/p?", url)
        self.assertIn("includeComputedAssemblyProperties=false", url)
        self.assertIn("configuration=Length%3D2%2Binch", url)

    def test_operations_use_op_labels_case_insensitive_properties_and_aliases(self):
        rows = [
            {
                "item": "1",
                "quantity": "1",
                "partNumber": "P-190B-260100",
                "name": "ROUTED PART",
                "MaNuFaCtUrInG MeThOd": "hAaS CnC",
                "manufacturing_method_op2": "bAMbu 3D pRinter",
                "Manufacturing Method OP3": "sHoPsAbRe",
                "Manufacturing Method OP4": "nOnE",
                "powder_coat_color": "bLaCk",
                "itemSource": source("https://example/direct", 0),
            }
        ]
        _, requirements, warnings = MODULE.build_records(
            rows,
            ["P-190B-26"],
            source_root="A-190B-260001",
            source_revision="B",
        )

        operations = MODULE.build_operation_records(requirements)

        self.assertEqual(warnings, [])
        self.assertEqual(requirements[0]["Finishing"], "Black")
        self.assertEqual(
            {
                f"Machine OP{index}": requirements[0][f"Machine OP{index}"]
                for index in range(1, 5)
            },
            {
                "Machine OP1": "Haas CNC",
                "Machine OP2": "Bambu 3D Printer",
                "Machine OP3": "Shop Sabre CNC",
                "Machine OP4": None,
            },
        )
        self.assertEqual(
            [
                (operation["Operation Number"], operation["Machine"])
                for operation in operations
            ],
            [
                ("OP1", "Haas CNC"),
                ("OP2", "Bambu 3D Printer"),
                ("OP3", "Shop Sabre CNC"),
            ],
        )
        self.assertTrue(all("OP4" not in operation["Operation"] for operation in operations))

    def test_operation_statuses_gate_each_route_on_its_predecessor(self):
        operations = [
            {
                "Operation": "route-a|OP2",
                "production_key": "route-a",
                "Operation Number": "OP2",
            },
            {
                "Operation": "route-a|OP1",
                "production_key": "route-a",
                "Operation Number": "OP1",
            },
            {
                "Operation": "route-b|OP3",
                "production_key": "route-b",
                "Operation Number": "OP3",
            },
        ]

        statuses = MODULE.operation_statuses_for_routes(operations, [])

        self.assertEqual(
            statuses,
            {
                "route-a|OP1": "Ready",
                "route-a|OP2": "Planned",
                "route-b|OP3": "Ready",
            },
        )

    def test_operation_statuses_unlock_next_op_and_preserve_work_states(self):
        operations = [
            {
                "Operation": "route-a|OP1",
                "production_key": "route-a",
                "Operation Number": "OP1",
            },
            {
                "Operation": "route-a|OP2",
                "production_key": "route-a",
                "Operation Number": "OP2",
            },
            {
                "Operation": "route-a|OP3",
                "production_key": "route-a",
                "Operation Number": "OP3",
            },
        ]
        existing_rows = [
            {
                "Operation": "route-a|OP1",
                "Status": {"id": 1, "value": "Complete"},
            },
            {
                "Operation": "route-a|OP2",
                "Status": {"id": 2, "value": "Planned"},
            },
            {
                "Operation": "route-a|OP3",
                "Status": {"id": 3, "value": "Blocked"},
            },
        ]

        statuses = MODULE.operation_statuses_for_routes(
            operations, existing_rows
        )

        self.assertEqual(statuses["route-a|OP1"], "Complete")
        self.assertEqual(statuses["route-a|OP2"], "Ready")
        self.assertEqual(statuses["route-a|OP3"], "Blocked")

    def test_operation_statuses_hide_a_prematurely_ready_downstream_op(self):
        operations = [
            {
                "Operation": "route-a|OP1",
                "production_key": "route-a",
                "Operation Number": "OP1",
            },
            {
                "Operation": "route-a|OP2",
                "production_key": "route-a",
                "Operation Number": "OP2",
            },
        ]
        existing_rows = [
            {"Operation": "route-a|OP1", "Status": "In Progress"},
            {"Operation": "route-a|OP2", "Status": "Ready"},
        ]

        statuses = MODULE.operation_statuses_for_routes(
            operations, existing_rows
        )

        self.assertEqual(statuses["route-a|OP1"], "In Progress")
        self.assertEqual(statuses["route-a|OP2"], "Planned")

    def test_custom_bom_header_display_name_is_available_for_operations(self):
        normalized = MODULE.normalize_bom_rows(
            [
                {
                    "id": "custom-op2",
                    "name": "Manufacturing Method OP2",
                    "propertyName": "opaqueCustomPropertyId",
                }
            ],
            [{"headerIdToValue": {"custom-op2": "SHOP SABRE"}}],
        )

        self.assertEqual(
            MODULE.operation_machines_from_row(normalized[0]),
            (("OP2", "Shop Sabre CNC"),),
        )

    def test_direct_parts_are_assigned_to_released_manufacturing_root(self):
        rows = [
            {
                "item": "1",
                "quantity": "2",
                "partNumber": "P-190B-260100",
                "name": "ROOT PLATE",
                "revision": "C",
                "itemSource": source("https://example/direct", 0),
            }
        ]
        _, requirements, _ = MODULE.build_records(
            rows,
            ["P-190B-26"],
            source_root="A-190B-260001",
            source_revision="B",
        )

        requirement = requirements[0]
        self.assertEqual(requirement["assembly_number"], "A-190B-260001")
        self.assertEqual(requirement["Source Root"], "A-190B-260001")
        self.assertEqual(requirement["Source Assembly Revision"], "B")
        self.assertEqual(requirement["Required Part Revision"], "C")
        self.assertEqual(
            requirement["Production Key"],
            "A-190B-260001|B|A-190B-260001|P-190B-260100|default",
        )

    def test_repeated_default_configuration_is_aggregated(self):
        rows = [
            {"name": "A-190B-260003", "partNumber": "", "itemSource": source("", 0)},
            {"item": "4.1.5", "quantity": "6.0", "partNumber": "P-190B-260434", "name": "MOUNTINGSTANDOFF", "material": {"displayName": "Aluminum - 6061"}, "manufacturingmethod": "LATHE", "itemSource": source("https://example/doc?configuration=default", 1)},
            {"item": "4.3", "quantity": "2.0", "partNumber": "P-190B-260434", "name": "MOUNTINGSTANDOFF", "material": {"displayName": "Aluminum - 6061"}, "manufacturingmethod": "LATHE", "itemSource": source("https://example/doc?configuration=default", 1)},
        ]
        parts, requirements, warnings = MODULE.build_records(rows, ["P-190B-26"])
        self.assertEqual(len(parts), 1)
        self.assertEqual(len(requirements), 1)
        self.assertEqual(requirements[0]["Required Quantity"], 8)
        self.assertEqual(requirements[0]["BOM Positions"], "4.1.5, 4.3")
        self.assertEqual(warnings, [])

    def test_distinct_configurations_remain_separate(self):
        rows = [
            {"name": "A-190B-260005", "partNumber": "", "itemSource": source("", 0)},
            {"item": "8.76.8", "quantity": "1", "partNumber": "P-190B-260574", "name": "ROLLER TUBE", "itemSource": source("https://example/doc?configuration=rollerLen%3D0.62%2Bmeter", 1)},
            {"item": "8.77.8", "quantity": "1", "partNumber": "P-190B-260574", "name": "ROLLER TUBE", "itemSource": source("https://example/doc?configuration=rollerLen%3D0.35%2Bmeter", 1)},
        ]
        _, requirements, _ = MODULE.build_records(rows, ["P-190B-26"])
        self.assertEqual(len(requirements), 2)
        self.assertEqual(
            {r["Configuration"] for r in requirements},
            {"rollerLen=0.62+meter", "rollerLen=0.35+meter"},
        )

    def test_bom_item_is_preserved_as_text(self):
        rows = [
            {"name": "A-190B-260002", "partNumber": "", "itemSource": source("", 0)},
            {"item": "1.10", "quantity": "1", "partNumber": "P-190B-260355", "name": "PLATE", "itemSource": source("https://example/doc?configuration=default", 1)},
        ]
        _, requirements, _ = MODULE.build_records(rows, ["P-190B-26"])
        self.assertEqual(requirements[0]["BOM Positions"], "1.10")


class BaserowClientTests(unittest.TestCase):
    def test_source_document_is_engineering_managed_without_owned_fields(self):
        class Client:
            def __init__(self):
                self.updated = []

            def list_rows(self, table_id):
                return [
                    {
                        "id": 7,
                        "Production Key": "REQ-1",
                        "Source Document": "A-26C-OLD",
                        "Status": "On Machine",
                        "Machinist": "Corey",
                        "QC Outcome": "Not Inspected",
                        "Disposition": "Make",
                        "Claimed Quantity": 2,
                        "Completed At": "2026-08-01T12:00:00Z",
                    }
                ]

            def batch_create(self, table_id, rows):
                raise AssertionError("The existing requirement should be updated")

            def batch_update(self, table_id, rows):
                self.updated.extend(rows)
                return rows

        client = Client()
        desired = [
            {
                "Production Key": "REQ-1",
                "Source Document": "A-26C-0001",
            }
        ]

        created, updated, unchanged = MODULE.upsert_table(
            client,
            1119642,
            "Production Key",
            desired,
            MODULE.PRODUCTION_REQUIREMENT_MANAGED_FIELDS,
            change_flag_field="Engineering Changed",
        )

        self.assertEqual((created, updated, unchanged), (0, 1, 0))
        self.assertEqual(client.updated[0]["Source Document"], "A-26C-0001")
        self.assertTrue(client.updated[0]["Engineering Changed"])
        for field in (
            "Status",
            "Machinist",
            "QC Outcome",
            "Disposition",
            "Claimed Quantity",
            "Completed At",
        ):
            self.assertNotIn(field, client.updated[0])

    def test_finishing_upsert_preserves_manually_assigned_machinist(self):
        class Client:
            def __init__(self):
                self.updated = []

            def list_rows(self, table_id):
                return [
                    {
                        "id": 7,
                        "Production Key": "REQ-1",
                        "Production Requirement": [3],
                        "Powder Coat Color": "Red",
                        "Required Quantity": 1,
                        "Active": True,
                        "Last Synced At": "old",
                        "Machinist": "Corey",
                    }
                ]

            def batch_create(self, table_id, rows):
                self.fail("The existing finishing row should be updated")

            def batch_update(self, table_id, rows):
                self.updated.extend(rows)
                return rows

        client = Client()
        desired = [
            {
                "Production Key": "REQ-1",
                "Production Requirement": [3],
                "Powder Coat Color": "Black",
                "Required Quantity": 4,
                "Active": True,
                "Last Synced At": "new",
            }
        ]
        managed_fields = (
            "Production Requirement",
            "Powder Coat Color",
            "Required Quantity",
            "Active",
            "Last Synced At",
        )

        created, updated, unchanged = MODULE.upsert_table(
            client, 6, "Production Key", desired, managed_fields
        )

        self.assertEqual((created, updated, unchanged), (0, 1, 0))
        self.assertEqual(len(client.updated), 1)
        self.assertNotIn("Machinist", client.updated[0])

    def test_root_revision_gate_matches_baserow_and_checks_discovery_membership(self):
        released = MODULE.released_assembly_from_revision(
            revision("B", VID_B, partNumber="A-ROOT-ONE")
        )
        discovery_master = "https://cad.onshape.com/documents/master/w/main/e/assembly"

        class Client:
            def list_rows(self, table_id):
                self.table_id = table_id
                return [
                    {
                        "Assembly Number": "A-ROOT-ONE",
                        "Latest Released Revision": "B",
                        "Sync Schema Version": MODULE.SYNC_SCHEMA_VERSION,
                        "Discovery Master": discovery_master,
                        "Integration Status": "Discovered — Master Unreleased",
                    }
                ]

        client = Client()
        env = {
            "BASEROW_API_URL": "https://api.baserow.test/api",
            "BASEROW_TOKEN": "test",
            "BASEROW_ASSEMBLIES_TABLE_ID": "4",
        }
        with patch.dict(os.environ, env), patch.object(
            MODULE, "BaserowClient", return_value=client
        ):
            self.assertTrue(
                MODULE.all_root_revisions_are_current(
                    [released], discovery_master
                )
            )

        self.assertEqual(client.table_id, 4)

    def test_root_revision_gate_detects_changed_revision_or_discovery_membership(self):
        released = MODULE.released_assembly_from_revision(
            revision("C", VID_B, partNumber="A-ROOT-ONE")
        )
        discovery_master = "https://cad.onshape.com/documents/master/w/main/e/assembly"

        class Client:
            def list_rows(self, table_id):
                return [
                    {
                        "Assembly Number": "A-ROOT-ONE",
                        "Latest Released Revision": "B",
                        "Discovery Master": discovery_master,
                        "Integration Status": "Discovered — Master Unreleased",
                    },
                    {
                        "Assembly Number": "A-ROOT-TWO",
                        "Latest Released Revision": "D",
                        "Discovery Master": discovery_master,
                        "Integration Status": "Discovered — Master Unreleased",
                    },
                ]

        env = {
            "BASEROW_API_URL": "https://api.baserow.test/api",
            "BASEROW_TOKEN": "test",
            "BASEROW_ASSEMBLIES_TABLE_ID": "4",
        }
        with patch.dict(os.environ, env), patch.object(
            MODULE, "BaserowClient", return_value=Client()
        ):
            self.assertFalse(MODULE.all_root_revisions_are_current([released]))

            same_revision = replace(released, revision="B")
            self.assertFalse(
                MODULE.all_root_revisions_are_current(
                    [same_revision], discovery_master
                )
            )

    def test_batch_create_error_includes_response_and_machine_values(self):
        response = RejectingResponse(
            {
                "error": "ERROR_REQUEST_BODY_VALIDATION",
                "detail": {
                    "items": {
                        "1": {"Machine OP2": [{"error": "Invalid select option"}]}
                    }
                },
            },
            status_code=400,
        )

        class Session:
            def post(self, url, json, timeout):
                return response

        client = object.__new__(MODULE.BaserowClient)
        client.base_url = "https://api.baserow.test/api"
        client.session = Session()
        items = [
            {
                "Production Key": "A-ROOT|A|A-ROOT|P-ONE|default",
                "Machine OP1": "Haas CNC",
                "Machine OP2": None,
            },
            {
                "Production Key": "A-ROOT|A|A-ROOT|P-TWO|default",
                "Machine OP1": "Shop Sabre CNC",
                "Machine OP2": "Haas CNC",
            },
        ]

        with self.assertRaises(RuntimeError) as raised:
            client.batch_create(1119642, items)

        message = str(raised.exception)
        self.assertIn("Baserow batch create failed for table 1119642", message)
        self.assertIn("ERROR_REQUEST_BODY_VALIDATION", message)
        self.assertIn('"batch_index": 1', message)
        self.assertIn("A-ROOT|A|A-ROOT|P-TWO|default", message)
        self.assertIn('"Machine OP2": "Haas CNC"', message)


class MultiRootSyncTests(unittest.TestCase):
    def test_unchanged_production_run_stops_before_fetching_root_bom(self):
        released = MODULE.released_assembly_from_revision(
            revision("B", VID_B, partNumber="A-ROOT-ONE")
        )

        with patch.object(
            MODULE, "resolve_latest_released_assembly", return_value=released
        ), patch.object(
            MODULE, "stale_root_revisions", return_value=(set(), False)
        ) as revision_gate, patch.object(
            MODULE, "fetch_bom", side_effect=AssertionError("BOM fetched")
        ), patch.object(
            MODULE, "sync_to_baserow", side_effect=AssertionError("full sync started")
        ):
            result = MODULE.run_sync([target()], ["P-190B-26"])

        self.assertTrue(result["skipped"])
        self.assertEqual(result["roots_checked"], 1)
        revision_gate.assert_called_once()

    def test_production_run_fetches_only_stale_root(self):
        first_target = target()
        second_target = MODULE.OnshapeTarget(
            "https://cad.onshape.com", "1" * 24, "w", "2" * 24, "3" * 24
        )
        first_release = MODULE.released_assembly_from_revision(
            revision("B", VID_B, partNumber="A-ROOT-ONE")
        )
        second_release = MODULE.released_assembly_from_revision(
            revision(
                "D",
                "4" * 24,
                documentId=second_target.did,
                elementId=second_target.eid,
                partNumber="A-ROOT-TWO",
            )
        )
        second_rows = [
            {
                "item": "1",
                "quantity": 1,
                "partNumber": "P-190B-260102",
                "name": "TWO",
                "revision": "E",
                "itemSource": source("https://example/two", 0),
            }
        ]

        with patch.object(
            MODULE,
            "resolve_latest_released_assembly",
            side_effect=[first_release, second_release],
        ), patch.object(
            MODULE,
            "stale_root_revisions",
            return_value=({MODULE.normalized_part_number("A-ROOT-TWO")}, False),
        ), patch.object(
            MODULE, "fetch_bom", return_value=second_rows
        ) as fetch_bom, patch.object(
            MODULE, "hydrate_operation_properties", side_effect=lambda rows, *_: rows
        ), patch.object(
            MODULE, "source_document_names_for_rows", return_value=({}, [])
        ), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({}, [])
        ), patch.object(
            MODULE, "sync_to_baserow", return_value={"updated": 1}
        ) as sync:
            result = MODULE.run_sync(
                [first_target, second_target], ["P-190B-26"]
            )

        self.assertEqual(result, {"updated": 1})
        fetch_bom.assert_called_once()
        self.assertEqual(fetch_bom.call_args.args[0].did, second_release.document_id)
        self.assertEqual(sync.call_args.kwargs["synced_roots"], {"A-ROOT-TWO"})
        self.assertEqual(
            [row["Source Root"] for row in sync.call_args.args[1]],
            ["A-ROOT-TWO"],
        )

    def test_bad_list_root_is_logged_and_remaining_root_syncs(self):
        bad_target = target()
        good_target = MODULE.OnshapeTarget(
            "https://cad.onshape.com", "1" * 24, "w", "2" * 24, "3" * 24
        )
        good_release = MODULE.released_assembly_from_revision(
            revision(
                "D",
                "4" * 24,
                documentId="1" * 24,
                elementId="3" * 24,
                partNumber="A-ROOT-TWO",
            )
        )
        good_rows = [
            {
                "item": "1",
                "quantity": 1,
                "partNumber": "P-190B-260102",
                "name": "TWO",
                "revision": "E",
                "itemSource": source("https://example/two", 0),
            }
        ]

        with patch.object(
            MODULE,
            "resolve_latest_released_assembly",
            side_effect=[RuntimeError("invalid latest-revision response"), good_release],
        ), patch.object(
            MODULE, "fetch_bom", return_value=good_rows
        ), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({}, [])
        ), patch("builtins.print") as printed:
            result = MODULE.run_sync(
                [bad_target, good_target], ["P-190B-26"], dry_run=True
            )

        warning = next(
            item for item in result["warnings"] if "could not be resolved" in item
        )
        self.assertIn(MODULE.onshape_target_url(bad_target), warning)
        self.assertIn("RuntimeError: invalid latest-revision response", warning)
        self.assertIn("existing Baserow requirements were left unchanged", warning)
        self.assertTrue(
            any(
                call.args
                and str(call.args[0]).startswith("WARNING: Manufacturing root ")
                for call in printed.call_args_list
            )
        )
        self.assertEqual(len(result["source_revisions"]), 1)
        self.assertEqual(
            result["source_revisions"][0]["part_number"], "A-ROOT-TWO"
        )

    def test_all_bad_list_roots_fail_before_baserow(self):
        with patch.object(
            MODULE,
            "resolve_latest_released_assembly",
            side_effect=RuntimeError("invalid latest-revision response"),
        ), patch.object(
            MODULE,
            "sync_to_baserow",
            side_effect=AssertionError("Baserow called"),
        ), self.assertRaisesRegex(RuntimeError, "Baserow was not changed"):
            MODULE.run_sync([target()], ["P-190B-26"])

    def test_no_released_direct_children_fails_before_baserow(self):
        with patch.object(MODULE, "fetch_bom", return_value=[]), patch.object(
            MODULE,
            "sync_to_baserow",
            side_effect=AssertionError("Baserow called"),
        ), self.assertRaisesRegex(RuntimeError, "Baserow was not changed"):
            MODULE.run_sync(
                target(), ["P-190B-26"], discover_from_master=True
            )

    def test_unreleased_master_discovers_child_release_without_being_released(self):
        child_did = "1" * 24
        child_eid = "2" * 24
        child_vid = "3" * 24
        master_rows = [
            {
                "name": "A-ROOT-ONE",
                "partNumber": "N/A",
                "revision": "",
                "indentLevel": 0,
                "itemSource": {
                    "documentId": child_did,
                    "elementId": child_eid,
                    "wvmType": "w",
                    "wvmId": "4" * 24,
                },
            }
        ]
        child_rows = [
            {
                "item": "1",
                "quantity": 2,
                "partNumber": "P-190B-260101",
                "name": "PLATE",
                "revision": "C",
                "itemSource": source("https://example/plate", 0),
            }
        ]
        child_release = revision(
            "B",
            child_vid,
            documentId=child_did,
            elementId=child_eid,
            partNumber="A-ROOT-ONE",
        )

        with patch.object(
            MODULE, "fetch_bom", side_effect=[master_rows, child_rows]
        ), patch.object(
            MODULE,
            "fetch_latest_discovered_assembly_revision",
            return_value=child_release,
        ), patch.object(
            MODULE,
            "resolve_latest_released_assembly",
            side_effect=AssertionError("master release was resolved"),
        ), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({}, [])
        ):
            result = MODULE.run_sync(
                target(),
                ["P-190B-26"],
                dry_run=True,
                discover_from_master=True,
            )

        self.assertIsNone(result["master_baseline_revision"])
        self.assertEqual(result["master_workspace_rows"], 1)
        self.assertEqual(len(result["requirements"]), 1)
        self.assertEqual(result["requirements"][0]["Source Root"], "A-ROOT-ONE")
        self.assertEqual(
            result["assemblies"][0]["Integration Status"],
            "Discovered — Master Unreleased",
        )
        self.assertEqual(
            result["assemblies"][0]["Discovery Master"],
            f"https://cad.onshape.com/documents/{DID}/w/{WID}/e/{EID}",
        )

    def test_independent_roots_use_master_only_for_revision_comparison(self):
        root_one_target = target()
        root_two_target = MODULE.OnshapeTarget(
            "https://cad.onshape.com", "1" * 24, "w", "2" * 24, "3" * 24
        )
        master_target = MODULE.OnshapeTarget(
            "https://cad.onshape.com", "4" * 24, "w", "5" * 24, "6" * 24
        )
        root_one = MODULE.released_assembly_from_revision(
            revision("B", VID_B, partNumber="A-ROOT-ONE")
        )
        root_two = MODULE.released_assembly_from_revision(
            revision(
                "D",
                "7" * 24,
                documentId="1" * 24,
                elementId="3" * 24,
                partNumber="A-ROOT-TWO",
            )
        )
        master = MODULE.released_assembly_from_revision(
            revision(
                "A",
                "8" * 24,
                documentId="4" * 24,
                elementId="6" * 24,
                partNumber="A-MASTER",
            )
        )
        root_one_rows = [
            {
                "item": "1",
                "quantity": 1,
                "partNumber": "P-190B-260101",
                "name": "ONE",
                "revision": "C",
                "itemSource": source("https://example/one", 0),
            }
        ]
        root_two_rows = [
            {
                "item": "1",
                "quantity": 1,
                "partNumber": "P-190B-260102",
                "name": "TWO",
                "revision": "E",
                "itemSource": source("https://example/two", 0),
            }
        ]
        master_rows = [
            {
                "name": "A-ROOT-ONE",
                "partNumber": "N/A",
                "revision": "A",
                "itemSource": source("", 0),
            },
            {
                "name": "A-ROOT-TWO",
                "partNumber": "N/A",
                "revision": "D",
                "itemSource": source("", 0),
            },
        ]

        with patch.object(
            MODULE,
            "resolve_latest_released_assembly",
            side_effect=[root_one, root_two, master],
        ), patch.object(
            MODULE,
            "fetch_bom",
            side_effect=[root_one_rows, root_two_rows, master_rows],
        ), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({}, [])
        ):
            result = MODULE.run_sync(
                [root_one_target, root_two_target],
                ["P-190B-26"],
                dry_run=True,
                master_target=master_target,
            )

        self.assertEqual(len(result["source_revisions"]), 2)
        self.assertEqual(len(result["requirements"]), 2)
        self.assertNotIn("P-190B", json.dumps(result["master_baseline_assemblies"]))
        assemblies = {
            row["Assembly Number"]: row for row in result["assemblies"]
        }
        self.assertEqual(
            assemblies["A-ROOT-ONE"]["Integration Status"],
            "Newer Revision Available",
        )
        self.assertEqual(
            assemblies["A-ROOT-TWO"]["Integration Status"],
            "Current in Master",
        )

    def test_deactivation_is_limited_to_the_current_source_root(self):
        table_ids = {
            "sync": 1,
            "parts": 2,
            "requirements": 3,
            "assemblies": 4,
            "operations": 5,
            "finishing": 6,
        }
        desired_part = {
            "Part Number": "P-190B-260101",
            "Name": "ONE",
            "Description": "",
            "Material": "",
            "Manufacturing Method": "",
            "Vendor": "",
            "Revision": "C",
            "OnShape Text": "RELEASED",
            "Category": "",
            "Onshape Drawing": "",
            "Active": True,
        }

        class Client:
            def __init__(self):
                self.rows = {
                    table_ids["assemblies"]: [
                        {
                            "id": 11,
                            "Assembly Number": "A-ROOT-TWO",
                            "Active": True,
                            "Discovery Master": "https://example/master",
                            "Integration Status": "Discovered — Master Unreleased",
                        },
                    ],
                    table_ids["parts"]: [{"id": 20, **desired_part}],
                    table_ids["requirements"]: [
                        {
                            "id": 30,
                            "Production Key": "old-one",
                            "Source Root": "A-ROOT-ONE",
                            "Assembly": [{"id": 10, "value": "A-ROOT-ONE"}],
                            "Machine OP1": None,
                            "Machine OP2": None,
                            "Machine OP3": None,
                            "Machine OP4": None,
                            "Finishing": None,
                            "Active in BOM": True,
                        },
                        {
                            "id": 31,
                            "Production Key": "other-root",
                            "Source Root": "A-ROOT-TWO",
                            "Assembly": [{"id": 11, "value": "A-ROOT-TWO"}],
                            "Active in BOM": True,
                        },
                        {
                            "id": 32,
                            "Production Key": "legacy-current-root",
                            "Assembly": [{"id": 10, "value": "A-ROOT-ONE"}],
                            "Active in BOM": True,
                        },
                        {
                            "id": 33,
                            "Production Key": "legacy-other-root",
                            "Assembly": [{"id": 11, "value": "A-ROOT-TWO"}],
                            "Active in BOM": True,
                        },
                    ],
                    table_ids["operations"]: [
                        {
                            "id": 40,
                            "Operation": "stale-current-root",
                            "Production Requirement": [{"id": 30}],
                            "Operation Number": "OP4",
                            "Machine": "Haas CNC",
                            "Status": "In Progress",
                            "Active in Routing": True,
                        },
                        {
                            "id": 41,
                            "Operation": "stale-other-root",
                            "Production Requirement": [{"id": 31}],
                            "Operation Number": "OP4",
                            "Machine": "Haas CNC",
                            "Status": "In Progress",
                            "Active in Routing": True,
                        },
                    ],
                    table_ids["finishing"]: [
                        {
                            "id": 60,
                            "Production Key": "stale-finishing",
                            "Production Requirement": [{"id": 30}],
                            "Active": True,
                        },
                        {
                            "id": 61,
                            "Production Key": "other-root-finishing",
                            "Production Requirement": [{"id": 31}],
                            "Active": True,
                        },
                    ],
                }
                self.updates = []
                self.next_id = 100

            def create_one(self, table_id, fields):
                return {"id": 1, **fields}

            def update_one(self, table_id, row_id, fields):
                return {"id": row_id, **fields}

            def list_rows(self, table_id):
                return list(self.rows[table_id])

            def batch_create(self, table_id, rows):
                created = []
                for row in rows:
                    self.next_id += 1
                    item = {"id": self.next_id, **row}
                    self.rows[table_id].append(item)
                    created.append(item)
                return created

            def batch_update(self, table_id, rows):
                self.updates.append((table_id, list(rows)))
                return rows

        client = Client()
        requirement = {
            "Production Key": (
                "A-ROOT-ONE|B|A-ROOT-ONE|P-190B-260101|default"
            ),
            "part_number": "P-190B-260101",
            "assembly_number": "A-ROOT-ONE",
            "Source Root": "A-ROOT-ONE",
            "Source Assembly Revision": "B",
            "Required Part Revision": "C",
            "Configuration": "default",
            "Required Quantity": 1,
            "BOM Positions": "1",
            "Onshape Source": "https://example/one",
            "Source Document": "A-26C-0001",
            "Machine OP1": "Haas CNC",
            "Machine OP2": "Tapping",
            "Machine OP3": None,
            "Machine OP4": None,
            "Finishing": "Red",
            "Active in BOM": True,
        }
        env = {
            "BASEROW_API_URL": "https://api.baserow.test/api",
            "BASEROW_TOKEN": "test",
            "BASEROW_SYNC_RUNS_TABLE_ID": "1",
            "BASEROW_PARTS_TABLE_ID": "2",
            "BASEROW_REQUIREMENTS_TABLE_ID": "3",
            "BASEROW_ASSEMBLIES_TABLE_ID": "4",
            "BASEROW_OPERATIONS_TABLE_ID": "5",
            "BASEROW_FINISHING_TABLE_ID": "6",
        }
        operation_key = requirement["Production Key"] + "|OP1"

        with patch.dict(os.environ, env), patch.object(
            MODULE, "BaserowClient", return_value=client
        ):
            MODULE.sync_to_baserow(
                [desired_part],
                [requirement],
                [],
                source_rows=1,
                exports_by_part={},
                sync_cad_files=False,
                operations=[
                    {
                        "Operation": operation_key,
                        "production_key": requirement["Production Key"],
                        "Operation Number": "OP1",
                        "Machine": "Haas CNC",
                        "Active in Routing": True,
                    }
                ],
                synced_roots={"A-ROOT-ONE"},
                discovery_master="https://example/master",
            )

        requirement_updates = [
            row
            for table_id, rows in client.updates
            if table_id == table_ids["requirements"]
            for row in rows
        ]
        deactivated_ids = {
            row["id"]
            for row in requirement_updates
            if row.get("Active in BOM") is False
        }
        self.assertEqual(deactivated_ids, {30, 32})
        operation_updates = [
            row
            for table_id, rows in client.updates
            if table_id == table_ids["operations"]
            for row in rows
        ]
        self.assertIn({"id": 40, "Active in Routing": False}, operation_updates)
        self.assertNotIn({"id": 41, "Active in Routing": False}, operation_updates)
        created_operation = next(
            row
            for row in client.rows[table_ids["operations"]]
            if row["Operation"] == operation_key
        )
        self.assertEqual(created_operation["Operation Number"], "OP1")
        self.assertEqual(created_operation["Machine"], "Haas CNC")
        self.assertEqual(created_operation["Status"], "Ready")
        assembly_updates = [
            row
            for table_id, rows in client.updates
            if table_id == table_ids["assemblies"]
            for row in rows
        ]
        self.assertIn(
            {
                "id": 11,
                "Integration Status": "Missing from Main — Review",
            },
            assembly_updates,
        )
        root_row = next(
            row
            for row in client.rows[table_ids["assemblies"]]
            if row["Assembly Number"] == "A-ROOT-ONE"
        )
        created_requirement = next(
            row
            for row in client.rows[table_ids["requirements"]]
            if row["Production Key"] == requirement["Production Key"]
        )
        self.assertTrue(root_row["Active"])
        self.assertEqual(created_requirement["Assembly"], [root_row["id"]])
        self.assertEqual(created_requirement["Machine OP1"], "Haas CNC")
        self.assertEqual(created_requirement["Machine OP2"], "Tapping")
        self.assertIsNone(created_requirement["Machine OP3"])
        self.assertIsNone(created_requirement["Machine OP4"])
        self.assertEqual(created_requirement["Finishing"], "Red")
        self.assertNotIn(
            "Source Document",
            created_requirement,
            "Fields absent from the existing Baserow schema must stay filtered",
        )
        finishing_row = next(
            row
            for row in client.rows[table_ids["finishing"]]
            if row["Production Key"] == requirement["Production Key"]
        )
        self.assertEqual(
            finishing_row["Production Requirement"], [created_requirement["id"]]
        )
        self.assertEqual(finishing_row["Powder Coat Color"], "Red")
        self.assertEqual(finishing_row["Required Quantity"], 1)
        self.assertTrue(finishing_row["Active"])
        finishing_updates = [
            row
            for table_id, rows in client.updates
            if table_id == table_ids["finishing"]
            for row in rows
        ]
        self.assertTrue(
            any(
                row.get("id") == 60 and row.get("Active") is False
                for row in finishing_updates
            )
        )
        self.assertFalse(any(row.get("id") == 61 for row in finishing_updates))


if __name__ == "__main__":
    unittest.main()
