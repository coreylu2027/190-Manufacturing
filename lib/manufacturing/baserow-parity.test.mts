import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as workflow from "../manufacturing-workflow.ts";
import * as demo from "../demo-data.ts";
import { projectOperations, projectFinishing } from "./projections.ts";
test("candidate projections match the actual unchanged Baserow adapter",async()=>{
  const source=await readFile(new URL("../baserow.ts",import.meta.url),"utf8");
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const operations=[{id:1,Operation:"root|part|OP1","Production Requirement":[{id:2,value:"P-1 — Bracket [A-1]"}],
    "Operation Number":{value:"OP1"},"Work Type":{value:"Manufacturing"},Machine:{value:"Mill"},Status:{value:"In Progress"},
    Machinist:"Alex A.","Active in Routing":true,"Claimed Quantity":"2","Completed Quantity":"1",
    "Quantity Ledger":'[{"userId":"id-a","name":"Alex A.","claimed":2,"completed":1}]',"Started At":"2026-09-01T12:00:00.123456Z"}];
  const requirements=[{id:2,Part:[{id:3,value:"P-1"}],"Required Quantity":"3",Status:{value:"Ready for Finishing"},Finishing:{value:"Red"},"Source Document":"A-Doc"}];
  const parts=[{id:3,Material:"Aluminum",Revision:"B"}];
  const finishing=[{id:4,"Production Key":"root|part","Production Requirement":[{id:2,value:"P-1 — Bracket [A-1]"}],Active:true,Machinist:"Alex A.","Powder Coat Color":{value:"Red"},"Required Quantity":"3"}];
  const tables:Record<string,unknown[]>={"1169282":operations,"1119642":requirements,"1119641":parts,"1170619":finishing};
  const fakeFetch=async(input:string,init:RequestInit)=>{
    assert.equal(init.method??"GET","GET");
    const id=new URL(input).pathname.match(/table\/(\d+)\//)?.[1];
    assert.ok(id&&tables[id]);return Response.json({count:tables[id].length,results:tables[id]});
  };
  const exports:Record<string,(...args:unknown[])=>Promise<unknown>>={};
  const require=(name:string)=>{
    if(name==="server-only")return {};
    if(name==="@/lib/manufacturing-workflow")return workflow;
    if(name==="@/lib/demo-data")return demo;
    throw new Error("Unexpected Baserow dependency: "+name);
  };
  new Function("require","exports","fetch","process",compiled)(require,exports,fakeFetch,{env:{BASEROW_API_TOKEN:"fixture-only"}});
  assert.deepEqual(await exports.getOperations(),{operations:projectOperations(operations,requirements,parts),source:"baserow"});
  assert.deepEqual(await exports.getFabricationJobs(),{jobs:projectFinishing(finishing,requirements),source:"baserow"});
});
