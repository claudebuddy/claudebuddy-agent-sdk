import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentTool, registerAgents, clearAgents } from '../src/tools/agent-tool.js'
import { ConfigTool, getConfig } from '../src/tools/config-tool.js'
import type { ToolContext } from '../src/types.js'
import type { LLMProvider, CreateMessageParams } from '../src/providers/types.js'
const reply = (content:any[]) => ({content,stopReason:'end_turn',usage:{input_tokens:1,output_tokens:1}})
function provider(fn:(p:CreateMessageParams)=>any):LLMProvider {return {apiType:'anthropic-messages',async createMessage(p){return fn(p)}}}
const input={prompt:'work',description:'test',subagent_type:'custom'}
test('subagent starts from parent tools and scoped definitions, never global registrations',async()=>{
 registerAgents({custom:{description:'global',prompt:'GLOBAL',tools:['Read']}})
 const requests:CreateMessageParams[]=[]
 const ctx:ToolContext={cwd:process.cwd(),tools:[ConfigTool,AgentTool],agents:{},provider:provider(p=>{requests.push(p);return reply([{type:'text',text:'done'}])})}
 try {
  await AgentTool.call(input,ctx)
  assert.deepEqual(requests[0].tools?.map(t=>t.name),['Config'])
  assert.ok(!requests[0].system.includes('GLOBAL'))
  ctx.agents={custom:{description:'local',prompt:'LOCAL',tools:[]}}
  await AgentTool.call(input,ctx)
  assert.deepEqual(requests[1].tools??[],[])
  assert.ok(requests[1].system.includes('LOCAL'))
 }finally{clearAgents()}
})
test('child tools inherit state and parent permission denials',async()=>{
 let turn=0
 const ctx:ToolContext={cwd:process.cwd(),tools:[ConfigTool],agents:{},sessionState:new Map(),canUseTool:async()=>({behavior:'deny',message:'blocked'}),provider:provider(()=>++turn===1?reply([{type:'tool_use',id:'1',name:'Config',input:{action:'set',key:'x',value:1}}]):reply([{type:'text',text:'done'}]))}
 await AgentTool.call(input,ctx)
 assert.equal(getConfig('x',ctx.sessionState),undefined)
 turn=0;ctx.canUseTool=async()=>({behavior:'allow'})
 await AgentTool.call(input,ctx)
 assert.equal(getConfig('x',ctx.sessionState),1)
})
test('child budget and cancellation failure remain errors',async()=>{
 let calls=0
 const ctx:ToolContext={cwd:process.cwd(),tools:[],agents:{},maxBudgetUsd:1,executionBudget:{cost:1,usage:{input_tokens:0,output_tokens:0}},provider:provider(()=>{calls++;return reply([{type:'text',text:'done'}])})}
 assert.equal((await AgentTool.call(input,ctx)).is_error,true)
 assert.equal(calls,0)
 ctx.maxBudgetUsd=undefined;ctx.abortSignal=AbortSignal.abort()
 assert.equal((await AgentTool.call(input,ctx)).is_error,true)
 assert.equal(calls,0)
})
test('inherit model sentinel resolves to the parent model',async()=>{
 const models:string[]=[]
 const ctx:ToolContext={cwd:process.cwd(),model:'parent-model',tools:[],agents:{custom:{description:'local',prompt:'test',model:'inherit'}},provider:provider(p=>{models.push(p.model);return reply([{type:'text',text:'done'}])})}
 await AgentTool.call(input,ctx)
 assert.deepEqual(models,['parent-model'])
})
