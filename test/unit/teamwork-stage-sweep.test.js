'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createStageSweepTool}=require('../../src/integrations/teamwork-stage-sweep');
const {readServerSource}=require('../helpers/server-source');
const args={assignee_user_ids:[1],week_start:'2026-11-09',week_end:'2026-11-15'};
function fixture(overrides={}){
 const task={id:10,name:'Work',status:'new',startDate:'2026-11-09',dueDate:'2026-12-01',assignees:[{id:1}],workflowStages:[{workflowId:2,stageId:0}],...overrides};
 const writes=[];let reads=0;
 const tool=createStageSweepTool({get:async url=>{
  if(url.includes('/tasks.json?'))return {tasks:[task],meta:{page:{hasMore:false}}};
  if(url.includes('/stages.json'))return {stages:[{id:3,name:'Ready to Start'}]};
  reads++;return {task:{...task,workflowStages:[{workflowId:2,stageId:writes.length?3:0}]}};
 },send:async(...a)=>{writes.push(a);}});
 return {tool,writes,task,get reads(){return reads;}};
}
test('sweep accepts start OR due within week and reads back every move',async()=>{
 for(const dates of [{startDate:'2026-11-09',dueDate:'2026-12-01'},{startDate:'2026-10-01',dueDate:'2026-11-15'}]){
  const f=fixture(dates),r=await f.tool.execute(args);
  assert.equal(r.moved.length,1);assert.equal(r.verified,true);assert.equal(f.reads,2);
  assert.deepEqual(f.writes[0].slice(0,3),['POST','/projects/api/v3/workflows/2/stages/3/tasks.json',{taskIds:[10]}]);
 }
});
test('only known stage zero, active tasks, requested assignees and week qualify',async()=>{
 for(const change of [{workflowStages:undefined},{workflowStages:[]},{workflowStages:[{workflowId:2,stageId:5}]},{status:'completed'},{isArchived:true},{deletedAt:'today'},{assignees:[{id:4}]},{startDate:'2026-11-16',dueDate:'2026-11-20'}]){
  const f=fixture(change);const r=await f.tool.execute(args);assert.equal(r.moved.length,0);assert.equal(f.writes.length,0);
 }
});
test('uncertain writes stop without retrying or claiming completion',async()=>{
 let writes=0;const task=fixture().task;
 const tool=createStageSweepTool({get:async url=>url.includes('/tasks.json?')?{tasks:[task]}:url.includes('/stages.json')?{stages:[{id:3,name:'Ready to Start'}]}:{task},send:async()=>{writes++;throw Error('timeout');}});
 const r=await tool.execute(args);assert.equal(r.complete,false);assert.equal(r.uncertain[0].id,10);assert.equal(writes,1);assert.equal(r.moved.length,0);
});
test('changed task is not overwritten and incomplete pagination cannot write',async()=>{
 let writes=0;const task=fixture().task;
 const tool=createStageSweepTool({get:async url=>url.includes('/tasks.json?')?{tasks:[task]}:url.includes('/stages.json')?{stages:[{id:3,name:'Ready to Start'}]}:{task:{...task,status:'completed'}},send:async()=>{writes++;}});
 const r=await tool.execute(args);assert.equal(r.skipped.length,1);assert.equal(writes,0);
 const partial=createStageSweepTool({get:async()=>({tasks:[task],meta:{page:{hasMore:true}}}),send:async()=>{writes++;}});
 await assert.rejects(partial.execute(args),/page limit/);assert.equal(writes,0);
});
test('invalid scope cannot read or write; readonly calendar does not enable writes',async()=>{
 const tool=createStageSweepTool({get:async()=>assert.fail('must not read'),send:async()=>assert.fail('must not write')});
 await assert.rejects(tool.execute({...args,assignee_user_ids:[]}),/verified people/);
 await assert.rejects(tool.execute({...args,week_end:'2026-11-30'}),/Monday-Sunday/);
 assert.match(readServerSource(),/nativeCalendarEnabled\(\) \|\| t.definition.name === 'calendar_list_events'/);
});
