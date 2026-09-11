import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskCreateTool, getAllTasks, clearTasks } from '../src/tools/task-tools.js'
import { TeamCreateTool, getAllTeams } from '../src/tools/team-tools.js'
import { ConfigTool, getConfig } from '../src/tools/config-tool.js'
import { TodoWriteTool, getTodos } from '../src/tools/todo-tool.js'
import { EnterPlanModeTool, isPlanModeActive } from '../src/tools/plan-tools.js'
import { SendMessageTool, readMailbox } from '../src/tools/send-message.js'
import { filterTools } from '../src/tools/index.js'
import * as goal from '../src/tools/update-goal.js'
import type { ToolContext } from '../src/types.js'
const context = (): ToolContext => ({ cwd: process.cwd(), sessionState: new Map() })
test('mutable tools and counters are isolated by session, with explicit sharing', async () => {
 const a=context(), b=context()
 await TaskCreateTool.call({subject:'secret'},a)
 await TeamCreateTool.call({name:'private'},a)
 await ConfigTool.call({action:'set',key:'secret',value:42},a)
 await TodoWriteTool.call({action:'add',text:'private'},a)
 await EnterPlanModeTool.call({},a)
 await SendMessageTool.call({to:'peer',content:'private'},a)
 assert.equal(getAllTasks(b.sessionState).length,0)
 assert.equal(getAllTeams(b.sessionState).length,0)
 assert.equal(getConfig('secret',b.sessionState),undefined)
 assert.equal(getTodos(b.sessionState).length,0)
 assert.equal(isPlanModeActive(b.sessionState),false)
 assert.equal(readMailbox('peer',b.sessionState).length,0)
 assert.equal(getAllTasks(a.sessionState)[0].subject,'secret')
 assert.equal(readMailbox('peer',a.sessionState)[0].content,'private')
 await TaskCreateTool.call({subject:'own'},b)
 assert.equal(getAllTasks(b.sessionState)[0].id,'task_1')
 a.sessionState!.clear()
 assert.equal(getAllTasks(a.sessionState).length,0)
 assert.equal(isPlanModeActive(a.sessionState),false)
 assert.equal(getAllTasks(b.sessionState).length,1)
})
test('direct helper compatibility and empty tool allowlists',async()=>{
 clearTasks()
 await TaskCreateTool.call({subject:'legacy'},{cwd:process.cwd()})
 assert.equal(getAllTasks()[0].subject,'legacy')
 clearTasks()
 assert.deepEqual(filterTools([TaskCreateTool],[]),[])
})
test('goal records belong to their run',async()=>{
 const a=goal.createGoalState(),b=goal.createGoalState()
 await goal.createUpdateGoalTool(a).call({goal_status:'complete'},context())
 assert.equal(goal.getGoalState(a).status,'complete')
 assert.equal(goal.getGoalState(b).status,'in_progress')
 goal.resetGoalState(5,a)
 assert.equal(goal.getGoalState(a).revision,5)
 assert.equal(goal.getGoalState(b).revision,0)
})

test('question, deferred tool and MCP registries are session owned', async () => {
 const { setQuestionHandler, AskUserQuestionTool } = await import('../src/tools/ask-user.js')
 const { setDeferredTools, ToolSearchTool } = await import('../src/tools/tool-search.js')
 const { setMcpConnections, ListMcpResourcesTool } = await import('../src/tools/mcp-resource-tools.js')
 const a=context(), b=context()
 setQuestionHandler(async()=> 'private answer',a.sessionState)
 setDeferredTools([TaskCreateTool],a.sessionState)
 setMcpConnections([{name:'private',status:'connected',tools:[]} as any],a.sessionState)
 assert.equal((await AskUserQuestionTool.call({question:'test'},a)).content,'private answer')
 assert.match(String((await AskUserQuestionTool.call({question:'test'},b)).content),/Non-interactive/)
 assert.match(String((await ToolSearchTool.call({query:'TaskCreate'},a)).content),/Found 1/)
 assert.match(String((await ToolSearchTool.call({query:'TaskCreate'},b)).content),/No deferred/)
 assert.match(String((await ListMcpResourcesTool.call({},a)).content),/private/)
 assert.match(String((await ListMcpResourcesTool.call({},b)).content),/No MCP/)
})

test('worktree ownership cannot be accessed from another session', async () => {
 const { mkdtemp, rm } = await import('node:fs/promises')
 const { tmpdir } = await import('node:os')
 const { join } = await import('node:path')
 const { execFileSync } = await import('node:child_process')
 const { EnterWorktreeTool, ExitWorktreeTool } = await import('../src/tools/worktree-tools.js')
 const dir=await mkdtemp(join(tmpdir(),'sdk-tool-state-'))
 try {
  execFileSync('git',['init',dir],{stdio:'ignore'})
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','initial'],{cwd:dir,stdio:'ignore'})
  const a={...context(),cwd:dir},b={...context(),cwd:dir}
  const result=await EnterWorktreeTool.call({branch:'test-worktree',path:join(dir,'child')},a)
  assert.ok(!result.is_error,String(result.content))
  const id=String(result.content).match(/ID: ([^\n]+)/)![1]
  assert.equal((await ExitWorktreeTool.call({id,action:'keep'},b)).is_error,true)
  assert.ok(!(await ExitWorktreeTool.call({id,action:'remove'},a)).is_error)
 }finally {await rm(dir,{recursive:true,force:true})}
})
