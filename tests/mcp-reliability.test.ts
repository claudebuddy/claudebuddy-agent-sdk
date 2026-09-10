import test from 'node:test'
import assert from 'node:assert/strict'
import { connectMCPServer } from '../src/mcp/client.js'
import { ListMcpResourcesTool, ReadMcpResourceTool, setMcpConnections } from '../src/tools/mcp-resource-tools.js'
const serverCode = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'test',version:'1'}, {capabilities:{tools:{},resources:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'wait',inputSchema:{type:'object',properties:{}}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>{await new Promise(r=>setTimeout(r,300));return {content:[{type:'text',text:'finished'}]}});
server.setRequestHandler(ListResourcesRequestSchema,async()=>{await new Promise(r=>setTimeout(r,100));return {resources:[{name:'sample',uri:'test://sample'}]}});
server.setRequestHandler(ReadResourceRequestSchema,async(req)=>{if(req.params.uri==='test://slow')await new Promise(r=>setTimeout(r,300));return {contents:[{uri:req.params.uri,text:'resource body'}]}});
await server.connect(new StdioServerTransport());
`
test('MCP tool and resources cross real SDK transport with cancellation',async()=>{
 const conn=await connectMCPServer('local',{type:'stdio',command:process.execPath,args:['--input-type=module','-e',serverCode]})
 try{
  assert.equal(conn.status,'connected')
  const context={cwd:process.cwd(),sessionState:new Map<string,unknown>()}
  setMcpConnections([conn],context.sessionState)
  const listed=await ListMcpResourcesTool.call({},context)
  assert.match(String(listed.content),/sample.*test:\/\/sample/)
  const read=await ReadMcpResourceTool.call({server:'local',uri:'test://sample'},context)
  assert.equal(read.content,'resource body')
  for(const operation of [
   (signal:AbortSignal)=>ListMcpResourcesTool.call({},{...context,abortSignal:signal}),
   (signal:AbortSignal)=>conn.tools[0].call({},{...context,abortSignal:signal}),
   (signal:AbortSignal)=>ReadMcpResourceTool.call({server:'local',uri:'test://slow'},{...context,abortSignal:signal}),
  ]){
   const controller=new AbortController()
   const timer=setTimeout(()=>controller.abort(),20)
   try{assert.equal((await operation(controller.signal)).is_error,true)}finally{clearTimeout(timer)}
  }
 }finally{await conn.close()}
})
test('unavailable resource APIs fail explicitly and aborted listings stop',async()=>{
 const context={cwd:process.cwd(),sessionState:new Map<string,unknown>()}
 setMcpConnections([{name:'absent',status:'connected',tools:[],async close(){}}],context.sessionState)
 assert.equal((await ReadMcpResourceTool.call({server:'absent',uri:'test://x'},context)).is_error,true)
 assert.match(String((await ListMcpResourcesTool.call({},context)).content),/not supported|No resources/)
 assert.equal((await ListMcpResourcesTool.call({},{...context,abortSignal:AbortSignal.abort()})).is_error,true)
})
