import importlib.util
import json
import os
from dataclasses import replace
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, Mock


MODULE_PATH = Path(__file__).with_name("OnshapeToSupabase.py")
sys.modules.setdefault("requests", types.ModuleType("requests"))
SPEC = importlib.util.spec_from_file_location("onshape_to_supabase", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def denied_network(*args, **kwargs):
    raise AssertionError("Tests must not call live APIs")


MODULE.requests.get = denied_network
MODULE.requests.post = denied_network
MODULE.requests.Session = denied_network


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
            result = MODULE.main(["--dry-run"])

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
            result = MODULE.main(["--dry-run"])

        self.assertEqual(result, 0)
        self.assertEqual(run_sync.call_args.args[0].did, DID)
        self.assertTrue(run_sync.call_args.kwargs["discover_from_master"])

    def test_main_passes_force_refresh_from_flag_or_environment(self):
        for argv, env_flag in ((["--dry-run", "--force-refresh"], "false"),
                               (["--dry-run"], "true")):
            with self.subTest(argv=argv, env_flag=env_flag), patch.dict(
                os.environ,
                {"ONSHAPE_DOC_URL": f"https://cad.onshape.com/documents/{DID}/w/{WID}/e/{EID}",
                 "FORCE_REFRESH": env_flag}, clear=True,
            ), patch.object(MODULE, "run_sync") as run_sync:
                MODULE.main(argv)
                self.assertTrue(run_sync.call_args.kwargs["force_refresh"])

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
                MODULE, "sync_to_supabase", side_effect=AssertionError("Supabase called")
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
        self.assertTrue(saved["parts"][0]["OnShape Text"].startswith(
            "https://cad.onshape.com/documents/part/v/version/e/studio"))
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

    def test_dry_run_writes_records_without_supabase(self):
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
                MODULE, "sync_to_supabase", side_effect=AssertionError("Supabase called")
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
        self.assertEqual(warnings, [])


class FileExportTests(unittest.TestCase):
    def sample_export(self, field=MODULE.STEP_FILE_FIELD):
        return MODULE.FileExport(
            part_number="P-190B-260100",
            field_name=field,
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


class RecordBuildingTests(unittest.TestCase):
    def test_subassembly_quantities_multiply_through_nested_bom(self):
        rows = [
            {"name": "A-190B-260003", "quantity": 3, "indentLevel": 0},
            {"partNumber": "P-190B-260434", "quantity": 4, "indentLevel": 1},
            {"name": "A-190B-260004", "quantity": 2, "indentLevel": 1},
            {"partNumber": "P-190B-260435", "quantity": 5, "indentLevel": 2},
            {"partNumber": "P-190B-260434", "quantity": 2, "indentLevel": 1},
            {"partNumber": "P-190B-260436", "quantity": 7, "indentLevel": 0},
        ]
        _, requirements, _ = MODULE.build_records(rows, ["P-190B-26"])
        quantities = {r["part_number"]: r["Required Quantity"] for r in requirements}
        self.assertEqual(quantities, {
            "P-190B-260434": 18,  # 3 * (4 + 2), after exiting nested assembly
            "P-190B-260435": 30,  # 3 * 2 * 5
            "P-190B-260436": 7,   # Outside all subassemblies
        })
        self.assertEqual(rows[1]["quantity"], 4)
        self.assertNotIn("_parent_quantity", rows[1])

    def test_unnamed_subassembly_quantity_and_missing_header_quantity(self):
        for quantity, expected in ((3, 12), (0, 0), (None, 4)):
            with self.subTest(quantity=quantity):
                rows = [
                    {"name": "Assembly", "quantity": quantity, "itemSource": source("", 0)},
                    {"partNumber": "P-190B-260434", "quantity": 4, "itemSource": source("", 1)},
                ]
                _, requirements, _ = MODULE.build_records(
                    rows, ["P-190B-26"], source_root="A-190B-260001"
                )
                self.assertEqual(requirements[0]["Required Quantity"], expected)
                self.assertEqual(requirements[0]["assembly_number"], "A-190B-260001")

    def test_every_supabase_machine_name_is_normalized_case_insensitively(self):
        for machine in MODULE.MACHINE_NAMES:
            with self.subTest(machine=machine):
                self.assertEqual(
                    MODULE.operation_machine_name(machine.swapcase()), machine
                )

    def test_requirement_machine_fields_use_exact_supabase_choice_casing(self):
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
            "A-190B-260001|C|A-190B-260001|P-190B-260100|default|v2",
        )

    def test_parent_revision_does_not_change_requirement_identity(self):
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
        _, before, _ = MODULE.build_records(
            rows,
            ["P-190B-26"],
            source_root="A-190B-260001",
            source_revision="B",
        )
        _, after, _ = MODULE.build_records(
            rows,
            ["P-190B-26"],
            source_root="A-190B-260001",
            source_revision="D",
        )

        self.assertEqual(before[0]["Production Key"], after[0]["Production Key"])
        self.assertEqual(after[0]["Source Assembly Revision"], "D")

    def test_duplicate_part_number_for_different_cad_parts_aborts(self):
        def identified_source(document_id, element_id, part_id):
            return {
                "viewHref": (
                    f"https://cad.onshape.com/documents/{document_id}/v/"
                    f"{'f' * 24}/e/{element_id}"
                ),
                "indentLevel": 1,
                "documentId": document_id,
                "elementId": element_id,
                "partId": part_id,
            }

        rows = [
            {
                "item": "1",
                "quantity": "1",
                "partNumber": "P-190B-260726",
                "name": "95T 5M 9mm Wide Belt",
                "revision": "B",
                "itemSource": identified_source("a" * 24, "b" * 24, "belt"),
            },
            {
                "item": "2",
                "quantity": "2",
                "partNumber": "P-190B-260726",
                "name": "Gear Spacer Intake Mechanism Middle",
                "revision": "A",
                "itemSource": identified_source("c" * 24, "d" * 24, "spacer"),
            },
        ]

        with self.assertRaisesRegex(
            MODULE.DuplicatePartNumberError, "Duplicate part number P-190B-260726"
        ):
            MODULE.build_records(
                rows,
                ["P-190B-26"],
                source_root="A-190B-261131",
                source_revision="B",
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


class CotsRecordTests(unittest.TestCase):
    ROWS = [
        {"name": "A-190B-260003", "quantity": 2, "partNumber": "N/A", "itemSource": source("", 0)},
        {"item": "1.1", "quantity": 4, "partNumber": "WCP-0215", "name": "Bearing",
         "manufacturingmethod": "Haas CNC", "Powder Coat Color": "Purple",
         "itemSource": source("https://example/bearing?configuration=default", 1)},
        {"item": "1.2", "quantity": 1, "partNumber": "am-4255", "name": "Gearbox",
         "itemSource": source("https://example/gearbox?configuration=default", 1)},
        {"item": "1.2.1", "quantity": 3, "partNumber": "am-0001", "name": "Gear",
         "itemSource": source("https://example/gear?configuration=default", 2)},
        {"item": "1.2.2", "quantity": 1, "partNumber": "P-190B-260900", "name": "Custom shaft",
         "manufacturingmethod": "Lathe", "itemSource": source("https://example/shaft?configuration=default", 2)},
        {"item": "1.3", "quantity": 2, "partNumber": "WCP-0215", "name": "Bearing",
         "itemSource": source("https://example/bearing?configuration=default", 1)},
        {"item": "1.4", "quantity": 8, "partNumber": "", "name": "Screw", "itemSource": source("", 1)},
    ]

    def test_cots_parts_are_excluded_unless_enabled(self):
        parts, requirements, _ = MODULE.build_records(
            self.ROWS, ["P-190B-26"], source_root="A-190B-260001", source_revision="A"
        )
        self.assertEqual([part["Part Number"] for part in parts], ["P-190B-260900"])
        self.assertNotIn("COTS", parts[0])
        self.assertEqual(len(requirements), 1)

    def test_cots_parts_sync_without_routing_or_finishing(self):
        parts, requirements, warnings = MODULE.build_records(
            self.ROWS, ["P-190B-26"], source_root="A-190B-260001",
            source_revision="A", include_cots=True,
        )
        self.assertEqual(warnings, [])
        cots = {part["Part Number"]: part["COTS"] for part in parts}
        self.assertEqual(cots, {"WCP-0215": True, "am-4255": True, "P-190B-260900": False})
        by_part = {requirement["part_number"]: requirement for requirement in requirements}
        self.assertEqual(by_part["WCP-0215"]["Required Quantity"], 12)  # 2 * (4 + 2)
        self.assertEqual(by_part["am-4255"]["Required Quantity"], 2)
        # A purchased gearbox's own gears are not listed; a team part inside it is.
        self.assertNotIn("am-0001", by_part)
        self.assertEqual(by_part["P-190B-260900"]["Required Quantity"], 2)
        for number in ("WCP-0215", "am-4255"):
            self.assertEqual(by_part[number]["_operation_machines"], ())
            self.assertEqual(by_part[number]["Finishing"], "None")
            self.assertIsNone(by_part[number]["Machine OP1"])
        self.assertEqual(MODULE.build_operation_records(requirements), [{
            "Operation": f"{by_part['P-190B-260900']['Production Key']}|OP1",
            "production_key": by_part["P-190B-260900"]["Production Key"],
            "Operation Number": "OP1",
            "Machine": "Lathe",
            "Active in Routing": True,
        }])
        self.assertEqual(MODULE.engineering_rows("parts", parts)[0]["cots"], True)

    def test_cots_library_copies_never_abort_the_sync(self):
        def copy(document_id):
            return {"partNumber": "WCP-0215", "name": f"Bearing {document_id}", "quantity": 1,
                    "itemSource": {"viewHref": f"https://cad.onshape.com/documents/{document_id}/v/{'f' * 24}/e/{'b' * 24}",
                                   "indentLevel": 0, "documentId": document_id,
                                   "elementId": "b" * 24, "partId": "JHD"}}

        parts, requirements, warnings = MODULE.build_records(
            [copy("a" * 24), copy("c" * 24)], ["P-190B-26"],
            source_root="A-190B-260001", source_revision="A", include_cots=True,
        )
        self.assertEqual(len(parts), 1)
        self.assertEqual(requirements[0]["Required Quantity"], 2)
        self.assertEqual(warnings, [])
        merged = MODULE.merge_root_parts([parts, [{**parts[0], "Name": "Other copy",
                                                    "_source_identity": ("x", "y", "z")}]], warnings)
        self.assertEqual(merged[0]["Name"], parts[0]["Name"])
        self.assertEqual(warnings, [])

    def test_main_reads_cots_flag_from_environment(self):
        environment = {
            "ONSHAPE_DOC_URL": f"https://cad.onshape.com/documents/{DID}/w/{WID}/e/{EID}",
            "PARTNUMBER_PREFIXES": "P-190B-26",
            "SYNC_COTS_PARTS": "true",
        }
        with patch.dict(os.environ, environment, clear=True), patch.object(
            MODULE, "run_sync", return_value={}
        ) as run_sync:
            MODULE.main(["--dry-run"])
        self.assertTrue(run_sync.call_args.kwargs["sync_cots"])


class MultiRootSyncTests(unittest.TestCase):
    def test_duplicate_part_identity_across_roots_aborts_merge(self):
        common = {
            "Part Number": "P-190B-260726",
            "Name": "same metadata would previously hide this collision",
            "Revision": "A",
            "Active": True,
        }
        belt = {
            **common,
            "_source_identity": ("a" * 24, "b" * 24, "belt"),
            "_source_root": "A-190B-261131",
        }
        spacer = {
            **common,
            "_source_identity": ("c" * 24, "d" * 24, "spacer"),
            "_source_root": "A-190B-261136",
        }

        with self.assertRaisesRegex(
            MODULE.DuplicatePartNumberError,
            "A-190B-261131, A-190B-261136",
        ):
            MODULE.merge_root_parts([[belt], [spacer]], [])

    def test_cross_root_collision_never_reaches_supabase(self):
        one = MODULE.released_assembly_from_revision(
            revision("B", VID_B, partNumber="A-ONE")
        )
        two = replace(one, part_number="A-TWO")
        belt = {
            "Part Number": "P-190B-260726",
            "Name": "95T 5M 9mm Wide Belt",
            "Revision": "B",
            "_source_identity": ("a" * 24, "b" * 24, "belt"),
            "_source_root": "A-ONE",
        }
        spacer = {
            "Part Number": "P-190B-260726",
            "Name": "Gear Spacer Intake Mechanism Middle",
            "Revision": "A",
            "_source_identity": ("c" * 24, "d" * 24, "spacer"),
            "_source_root": "A-TWO",
        }
        with patch.object(
            MODULE, "resolve_latest_released_assembly", side_effect=[one, two]
        ), patch.object(
            MODULE, "stale_root_revisions", return_value=({"a-one", "a-two"}, False)
        ), patch.object(
            MODULE, "fetch_bom", return_value=[]
        ), patch.object(
            MODULE, "hydrate_operation_properties", return_value=[]
        ), patch.object(
            MODULE, "source_document_names_for_rows", return_value=({}, [])
        ), patch.object(
            MODULE, "build_records", side_effect=[([belt], [], []), ([spacer], [], [])]
        ), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({}, [])
        ), patch.object(
            MODULE, "sync_to_supabase", side_effect=AssertionError("Supabase called")
        ):
            with self.assertRaises(MODULE.DuplicatePartNumberError):
                MODULE.run_sync([target(), replace(target(), did="1" * 24)], [])

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
            MODULE, "sync_to_supabase", side_effect=AssertionError("full sync started")
        ):
            result = MODULE.run_sync([target()], ["P-190B-26"])

        self.assertTrue(result["skipped"])
        self.assertEqual(result["roots_checked"], 1)
        revision_gate.assert_called_once()

    def test_force_refresh_rebuilds_unchanged_root_and_preserves_scope(self):
        released = MODULE.released_assembly_from_revision(
            revision("B", VID_B, partNumber="A-ROOT-ONE")
        )
        rows = [
            {"name": "A-190B-260003", "quantity": 3, "indentLevel": 0},
            {"partNumber": "P-190B-260434", "quantity": 4, "indentLevel": 1},
        ]
        with patch.object(
            MODULE, "resolve_latest_released_assembly", return_value=released
        ), patch.object(
            MODULE, "stale_root_revisions", return_value=(set(), False)
        ), patch.object(
            MODULE, "fetch_bom", return_value=rows
        ) as fetch_bom, patch.object(
            MODULE, "hydrate_operation_properties", side_effect=lambda rows, *_: rows
        ), patch.object(
            MODULE, "source_document_names_for_rows", return_value=({}, [])
        ), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({}, [])
        ), patch.object(
            MODULE, "sync_to_supabase", return_value={"updated": 1}
        ) as sync:
            result = MODULE.run_sync([target()], ["P-190B-26"], force_refresh=True)

        self.assertEqual(result, {"updated": 1})
        fetch_bom.assert_called_once()
        self.assertEqual(sync.call_args.args[1][0]["Required Quantity"], 12)
        self.assertEqual(sync.call_args.kwargs["synced_roots"], {"A-ROOT-ONE"})
        self.assertEqual(sync.call_args.kwargs["discovered_roots"], {"A-ROOT-ONE"})

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
            MODULE, "sync_to_supabase", return_value={"updated": 1}
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
        self.assertIn("existing Supabase requirements were left unchanged", warning)
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

    def test_all_bad_list_roots_fail_before_supabase(self):
        with patch.object(
            MODULE,
            "resolve_latest_released_assembly",
            side_effect=RuntimeError("invalid latest-revision response"),
        ), patch.object(
            MODULE,
            "sync_to_supabase",
            side_effect=AssertionError("Supabase called"),
        ), self.assertRaisesRegex(RuntimeError, "Supabase was not changed"):
            MODULE.run_sync([target()], ["P-190B-26"])

    def test_no_released_direct_children_fails_before_supabase(self):
        with patch.object(MODULE, "fetch_bom", return_value=[]), patch.object(
            MODULE,
            "sync_to_supabase",
            side_effect=AssertionError("Supabase called"),
        ), self.assertRaisesRegex(RuntimeError, "Supabase was not changed"):
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


class SupabaseSyncTests(unittest.TestCase):
    def test_secret_key_auth_and_rpc_use_public_endpoint(self):
        session = Mock(headers={})
        session.post.return_value = FakeResponse([])
        with patch.object(MODULE.requests, "Session", return_value=session):
            client = MODULE.SupabaseClient("https://project.supabase.test", "sb_secret_fixture")
        self.assertEqual(session.headers, {"apikey": "sb_secret_fixture"})
        client.root_state()
        self.assertEqual(session.post.call_args.args[0],
                         "https://project.supabase.test/rest/v1/rpc/manufacturing_engineering_sync_state")
        self.assertNotIn("Accept-Profile", session.headers)
        session.headers = {}
        with patch.object(MODULE.requests, "Session", return_value=session):
            MODULE.SupabaseClient("https://project.supabase.test", "fixture-jwt")
        self.assertEqual(session.headers["Authorization"], "Bearer fixture-jwt")

    def test_private_storage_uses_content_address_and_verifies_duplicate_bytes(self):
        session = Mock(headers={})
        session.post.return_value = FakeResponse({"error": "Duplicate"}, 409)
        session.get.return_value = Mock(content=b"STEP")
        with patch.object(MODULE.requests, "Session", return_value=session):
            client = MODULE.SupabaseClient("https://project.supabase.test", "sb_secret_fixture")
        result = client.upload_file("plate.step", b"STEP", "application/step")
        digest = MODULE.hashlib.sha256(b"STEP").hexdigest()
        self.assertEqual(result["storage_path"], f"sha256/{digest[:2]}/{digest}.step")
        self.assertEqual(session.post.call_args.kwargs["headers"]["x-upsert"], "false")
        self.assertNotIn("/public/", session.get.call_args.args[0])
        session.get.return_value.content = b"wrong"
        with self.assertRaisesRegex(RuntimeError, "verification"):
            client.upload_file("plate.step", b"STEP", "application/step")

    def test_storage_permission_error_is_not_a_duplicate(self):
        client = object.__new__(MODULE.SupabaseClient)
        client.base_url = "https://project.supabase.test"
        client.session = Mock()
        client.session.post.return_value = RejectingResponse({"error": "AccessDenied"}, 403)
        with self.assertRaises(RuntimeError):
            client.upload_file("plate.pdf", b"PDF", "application/pdf")
        client.session.get.assert_not_called()

    def test_payload_is_one_transaction_with_business_keys_and_no_shop_fields(self):
        client = Mock()
        client.rpc.return_value = {"status": "success"}
        requirements = [{"Production Key": "ROOT|A|ROOT|P|default|v2", "part_number": "P",
            "assembly_number": "ROOT", "Source Root": "ROOT", "Finishing": "Red",
            "Required Quantity": 4, "Status": "DO NOT SEND", "Machinist": "DO NOT SEND",
            "QC Outcome": "DO NOT SEND", "location_id": 9}]
        operations = [{"Operation": "ROOT|A|ROOT|P|default|v2|OP1", "production_key": requirements[0]["Production Key"],
            "Operation Number": "OP1", "Machine": "Haas CNC", "Active in Routing": True,
            "Status": "Ready", "Claimed Quantity": 6, "Completed Quantity": 2}]
        with patch.object(MODULE.SupabaseClient, "from_env", return_value=client):
            MODULE.sync_to_supabase([{"Part Number": "P", "Name": "Plate"}], requirements, [], 1,
                {}, False, operations=operations, synced_roots={"ROOT"}, run_id="fixture")
        client.rpc.assert_called_once()
        payload = client.rpc.call_args.kwargs["p_payload"]
        self.assertEqual(payload["requirements"][0]["part_number"], "P")
        self.assertNotIn("part_id", payload["requirements"][0])
        self.assertEqual(payload["operations"][0]["production_key"], requirements[0]["Production Key"])
        self.assertEqual(payload["finishing"][0]["required_quantity"], 4)
        self.assertNotIn("DO NOT SEND", json.dumps(payload))
        self.assertNotIn("status", payload["operations"][0])
        self.assertNotIn("claimed_quantity", payload["operations"][0])
        client.attachment_state.assert_not_called()

    def test_database_failure_is_reported_and_not_retried_as_table_writes(self):
        client = Mock()
        client.rpc.return_value = {"status": "failed", "error": "invalid relation"}
        with patch.object(MODULE.SupabaseClient, "from_env", return_value=client):
            with self.assertRaisesRegex(RuntimeError, "rolled back"):
                MODULE.sync_to_supabase([], [], [], 0, {}, False, run_id="fixture")
        client.rpc.assert_called_once()
        client.finish_run.assert_called_once()

    def test_main_records_onshape_failure_and_skip_without_credentials_in_dry_run(self):
        client = Mock()
        client.begin_run.return_value = "fixture"
        env = {"ONSHAPE_DOC_URL": MODULE.onshape_target_url(target())}
        with patch.dict(os.environ, env, clear=True), patch.object(
            MODULE.SupabaseClient, "from_env", return_value=client
        ), patch.object(MODULE, "run_sync", side_effect=RuntimeError("Onshape unavailable")):
            with self.assertRaisesRegex(RuntimeError, "Onshape unavailable"):
                MODULE.main([])
        self.assertEqual(client.finish_run.call_args.args[1], "failed")
        client.reset_mock()
        with patch.dict(os.environ, env, clear=True), patch.object(
            MODULE.SupabaseClient, "from_env", return_value=client
        ), patch.object(MODULE, "run_sync", return_value={"skipped": True, "warnings": ["root unresolved"]}):
            MODULE.main([])
        self.assertEqual(client.finish_run.call_args.args[1], "partial")
        with patch.dict(os.environ, env, clear=True), patch.object(
            MODULE.SupabaseClient, "from_env", side_effect=AssertionError("destination accessed")
        ), patch.object(MODULE, "run_sync", return_value={"dry_run": True}):
            self.assertEqual(MODULE.main(["--dry-run"]), 0)

    def test_revision_gate_requires_cad_completion_only_when_requested(self):
        released = MODULE.released_assembly_from_revision(revision("B", VID_B))
        client = Mock()
        client.root_state.return_value = [{"Assembly Number": released.part_number,
            "Latest Released Revision": "B", "Sync Schema Version": MODULE.SYNC_SCHEMA_VERSION,
            "CAD Synced": False}]
        with patch.object(MODULE.SupabaseClient, "from_env", return_value=client):
            self.assertEqual(MODULE.stale_root_revisions([released]), (set(), False))
            self.assertTrue(MODULE.stale_root_revisions([released], sync_cad_files=True)[0])
            client.root_state.return_value[0]["CAD Synced"] = True
            self.assertEqual(MODULE.stale_root_revisions([released], sync_cad_files=True), (set(), False))
            client.root_state.return_value[0]["Sync Schema Version"] = "old"
            self.assertTrue(MODULE.stale_root_revisions([released])[0])

    def test_membership_change_does_not_rescan_unchanged_bom_or_drawings(self):
        released = MODULE.released_assembly_from_revision(revision("B", VID_B))
        reference = MODULE.OnshapeDocumentReference(target().base_url,DID,"w",WID)
        with patch.object(MODULE, "fetch_bom", return_value=[]) as bom, patch.object(
            MODULE, "discover_released_manufacturing_roots", return_value=([(reference,released)], [])
        ), patch.object(MODULE, "stale_root_revisions", return_value=(set(), True)), patch.object(
            MODULE, "drawing_urls_for_parts", side_effect=AssertionError("drawings rescanned")
        ), patch.object(MODULE, "sync_to_supabase", return_value={"status": "success"}) as sync:
            MODULE.run_sync(target(), [], discover_from_master=True)
        bom.assert_called_once()  # Main discovery only.
        self.assertEqual(sync.call_args.kwargs["synced_roots"], set())
        self.assertEqual(sync.call_args.kwargs["discovered_roots"], {released.part_number})

    def test_no_revision_never_reaches_drawings(self):
        with patch.object(MODULE, "resolve_latest_released_assembly", side_effect=RuntimeError("No released revision")), patch.object(
            MODULE, "fetch_bom", side_effect=AssertionError("BOM fetched")
        ), patch.object(MODULE, "drawing_urls_for_parts", side_effect=AssertionError("drawings scanned")):
            with self.assertRaisesRegex(RuntimeError, "No configured"):
                MODULE.run_sync(target(), [], dry_run=True)

    def test_failed_root_bom_is_excluded_from_deactivation_scope(self):
        one = MODULE.released_assembly_from_revision(revision("B", VID_B, partNumber="A-ONE"))
        two = replace(one, part_number="A-TWO")
        with patch.object(MODULE, "resolve_latest_released_assembly", side_effect=[one,two]), patch.object(
            MODULE, "stale_root_revisions", return_value=({"a-one","a-two"},False)
        ), patch.object(MODULE, "fetch_bom", side_effect=[RuntimeError("timeout"),[]]), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({},[])
        ), patch.object(MODULE, "sync_to_supabase", return_value={"status":"partial"}) as sync:
            MODULE.run_sync([target(),replace(target(),did="1"*24)], [])
        self.assertEqual(sync.call_args.kwargs["synced_roots"], {"A-TWO"})
        self.assertIn("timeout", sync.call_args.args[2][0])

    def test_dry_run_discovery_never_generates_bom_or_translates(self):
        released = MODULE.released_assembly_from_revision(revision("B",VID_B))
        reference = MODULE.OnshapeDocumentReference(target().base_url,DID,"w",WID)
        with patch.dict(os.environ, {}, clear=True), patch.object(MODULE, "fetch_bom", return_value=[]) as bom, patch.object(
            MODULE, "discover_released_manufacturing_roots", return_value=([(reference,released)],[])
        ), patch.object(MODULE, "drawing_urls_for_parts", return_value=({},[])), patch.object(
            MODULE, "start_file_translation", side_effect=AssertionError("mutation")
        ), patch.object(MODULE.SupabaseClient, "from_env", side_effect=AssertionError("credentials")):
            MODULE.run_sync(target(), [], dry_run=True, sync_cad_files=True, discover_from_master=True)
        self.assertFalse(bom.call_args_list[0].kwargs["generate_if_absent"])

    def test_cached_export_group_skips_onshape_translation(self):
        export = FileExportTests().sample_export()
        state = [{"part_number": export.part_number, "kind": "step", "file_count": 1,
                  "export_key": MODULE.aggregate_export_key([export])}]
        with patch.object(MODULE, "start_file_translation", side_effect=AssertionError("translation")):
            groups,cached = MODULE.attach_exported_files(object(), [{"Part Number":export.part_number}],
                state, {export.part_number:[export]}, [])
        self.assertEqual((groups,cached), ([],1))

    def test_incomplete_export_group_never_updates_catalog_or_marker(self):
        export = FileExportTests().sample_export()
        second = replace(export, source_key="second")
        client=Mock()
        client.upload_file.side_effect=[{"original_name":"first.step"},RuntimeError("upload failed")]
        warnings=[]
        with patch.object(MODULE,"start_file_translation",return_value={}), patch.object(
            MODULE,"wait_for_translation",return_value={}
        ), patch.object(MODULE,"download_translation",return_value=b"STEP"):
            groups,cached=MODULE.attach_exported_files(client,[{"Part Number":export.part_number}],[],
                {export.part_number:[export,second]},warnings)
        self.assertEqual(groups,[])
        self.assertIn("upload failed",warnings[0])

    def test_completed_export_retains_configured_filename(self):
        export=FileExportTests().sample_export()
        client=Mock()
        client.upload_file.return_value={"original_name":"Configured Shop Export.step"}
        with patch.object(MODULE,"start_file_translation",return_value={}), patch.object(
            MODULE,"wait_for_translation",return_value={"exportRuleFileName":"Configured Shop Export"}
        ), patch.object(MODULE,"download_translation",return_value=b"STEP"):
            groups,cached=MODULE.attach_exported_files(client,[{"Part Number":export.part_number}],[],
                {export.part_number:[export]},[])
        self.assertEqual(client.upload_file.call_args.args[0],"Configured Shop Export.step")
        self.assertEqual(groups[0]["export_key"],MODULE.aggregate_export_key([export]))
        self.assertEqual(groups[0]["files"][0]["source_metadata"]["request"],export.request_body)


class StagedReviewTests(unittest.TestCase):
    def requirement(self):
        return {"Production Key": "ROOT|A|ROOT|P|default|v2", "part_number": "P",
                "assembly_number": "ROOT", "Source Root": "ROOT", "Finishing": "None",
                "Required Quantity": 2}

    def test_staging_sends_the_commit_payload_and_never_commits(self):
        client = Mock()
        client.stage_run.return_value = {"status": "staged", "proposal_id": "fixture"}
        details = {"label": "Poot Horse", "source_revisions": []}
        with patch.object(MODULE.SupabaseClient, "from_env", return_value=client):
            result = MODULE.sync_to_supabase([{"Part Number": "P", "Name": "Plate"}], [self.requirement()], [], 1,
                {}, False, synced_roots={"ROOT"}, run_id="fixture", stage_for_review=True, review_details=details)
        self.assertEqual(result["status"], "staged")
        client.rpc.assert_not_called()
        client.finish_run.assert_not_called()
        run_id, payload, sent_details = client.stage_run.call_args.args
        self.assertEqual((run_id, sent_details), ("fixture", details))
        self.assertEqual(payload["synced_roots"], ["ROOT"])
        self.assertEqual(payload["requirements"][0]["production_key"], "ROOT|A|ROOT|P|default|v2")

    def test_unexpected_staging_result_records_a_failed_run(self):
        client = Mock()
        client.stage_run.return_value = {"status": "success"}
        with patch.object(MODULE.SupabaseClient, "from_env", return_value=client):
            with self.assertRaisesRegex(RuntimeError, "staging"):
                MODULE.sync_to_supabase([], [], [], 0, {}, False, run_id="fixture", stage_for_review=True)
        self.assertEqual(client.finish_run.call_args.args[1], "failed")

    def test_run_sync_forwards_review_details_for_synced_roots_only(self):
        one = MODULE.released_assembly_from_revision(revision("B", VID_B, partNumber="A-ONE"))
        two = replace(one, part_number="A-TWO")
        with patch.object(MODULE, "resolve_latest_released_assembly", side_effect=[one, two]), patch.object(
            MODULE, "stale_root_revisions", return_value=({"a-one", "a-two"}, False)
        ), patch.object(MODULE, "fetch_bom", side_effect=[RuntimeError("timeout"), []]), patch.object(
            MODULE, "drawing_urls_for_parts", return_value=({}, [])
        ), patch.object(MODULE, "sync_to_supabase", return_value={"status": "staged"}) as sync:
            MODULE.run_sync([target(), replace(target(), did="1" * 24)], [], stage_for_review=True,
                            review_label="Poot Horse", force_refresh=True)
        kwargs = sync.call_args.kwargs
        self.assertTrue(kwargs["stage_for_review"])
        details = kwargs["review_details"]
        self.assertEqual((details["label"], details["force_refresh"], details["roots_checked"]), ("Poot Horse", True, 2))
        self.assertEqual([item["part_number"] for item in details["source_revisions"]], ["A-TWO"])

    def test_main_reads_stage_flag_and_links_the_review_in_the_job_summary(self):
        client = Mock()
        client.begin_run.return_value = "fixture"
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / "summary.md"
            env = {"ONSHAPE_DOC_URL": MODULE.onshape_target_url(target()), "STAGE_FOR_REVIEW": "true",
                   "SYNC_LABEL": "Poot Horse", "MANUFACTURING_APP_URL": "https://shop.example.test/",
                   "GITHUB_STEP_SUMMARY": str(summary)}
            with patch.dict(os.environ, env, clear=True), patch.object(
                MODULE.SupabaseClient, "from_env", return_value=client
            ), patch.object(MODULE, "run_sync", return_value={"status": "staged", "proposal_id": "abc"}) as run:
                self.assertEqual(MODULE.main([]), 0)
            self.assertTrue(run.call_args.kwargs["stage_for_review"])
            self.assertEqual(run.call_args.kwargs["review_label"], "Poot Horse")
            self.assertIn("https://shop.example.test/admin/sync?proposal=abc", summary.read_text(encoding="utf-8"))
        client.finish_run.assert_not_called()
        with patch.dict(os.environ, {"ONSHAPE_DOC_URL": MODULE.onshape_target_url(target())}, clear=True), patch.object(
            MODULE.SupabaseClient, "from_env", return_value=client
        ), patch.object(MODULE, "run_sync", return_value={"status": "success"}) as run:
            MODULE.main([])
        self.assertFalse(run.call_args.kwargs["stage_for_review"])


if __name__ == "__main__":
    unittest.main()
