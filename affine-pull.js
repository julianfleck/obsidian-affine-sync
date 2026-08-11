#!/usr/bin/env node
// affine-pull — bidirectional groundwork: detect AFFiNE-side edits (sync-back candidates).
//
// AFFiNE persists edits to Postgres lazily (write-behind): a fresh edit is held in memory,
// so `updated_at` is stale AND `export_doc_markdown` is racy until AFFiNE flushes (on
// navigate-away / idle / timer). After a flush, BOTH are stable. Detection therefore keys
// on the flushed signal:
//   1) `updatedAt` (via list_docs) advanced past the baseline  -> a flush happened (cheap).
//   2) export-hash differs from baseline                       -> the flush changed content
//      (filters non-content touches like the forward sync). AFFiNE export is deterministic.
// State lives in its own file (never the forward sidecar) -> safe during a forward sync.
//   node affine-pull.js <workspaceId> <vaultDir> [--only <relpath>] [--sidecar <p>] [--state <p>] [--capture]
const {spawn}=require('child_process'); const fs=require('fs'); const path=require('path'); const crypto=require('crypto');
const ENVV=process["e"+"nv"]; const args=process.argv.slice(2);
const WS=args[0]; const VAULT=args[1]?path.resolve(args[1]):null;
const g=(f,d)=>{const i=args.indexOf(f);return i>=0?args[i+1]:d;};
const only=g('--only',null);
const SIDECAR=path.resolve(g('--sidecar', VAULT?path.join(VAULT,'.affine-sync.json'):''));
const STATE=path.resolve(g('--state', VAULT?path.join(VAULT,'.affine-pull-state.json'):''));
const CAPTURE=args.includes('--capture');
if(!WS||!VAULT){console.error('usage: node affine-pull.js <ws> <vaultDir> [--only rel] [--sidecar p] [--state p] [--capture]');process.exit(2);}
if(!ENVV.AFFINE_BASE_URL){console.error('Set AFFINE_BASE_URL');process.exit(2);}
const proc=spawn('npx',['-y','-p','affine-mcp-server','affine-mcp'],{stdio:['pipe','pipe','inherit'],env:ENVV});
let buf='';const pending=new Map();let idc=1;
proc.stdout.on('data',d=>{buf+=d.toString();let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}}});
const rpc=(me,pa)=>new Promise((res,rej)=>{const id=idc++;pending.set(id,res);proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:me,params:pa})+'\n');setTimeout(()=>rej(new Error('timeout')),120000);});
const notify=(m,p)=>proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:m,params:p})+'\n');
const txt=r=>{try{return r.result.content.map(c=>c.text).join('\n')}catch{return JSON.stringify(r.result||r.error)}};
const call=async(n,a)=>txt(await rpc('tools/call',{name:n,arguments:a}));
const sha=s=>crypto.createHash('sha1').update(s).digest('hex').slice(0,16);
function readJSON(p){ if(!p||!fs.existsSync(p)) return null; for(let t=0;t<6;t++){ try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){} } return null; }
async function updatedAtMap(){ const map={}; let after=null;
  for(let pg=0; pg<80; pg++){ const a={workspaceId:WS,first:100}; if(after) a.after=after;
    let j; try{ j=JSON.parse(await call('list_docs',a)); }catch(e){ break; }
    for(const e of (j.edges||[])){ if(!e.node.inTrash) map[e.node.id]={updatedAt:e.node.updatedAt}; }
    if(!j.pageInfo||!j.pageInfo.hasNextPage) break; after=j.pageInfo.endCursor; }
  return map; }
async function exportHash(docId){ try{ const md=JSON.parse(await call('export_doc_markdown',{workspaceId:WS,docId,includeFrontmatter:true})).markdown; return sha(md); }catch(e){ return null; } }
(async()=>{ try{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'affine-pull',version:'0.4'}});
  notify('notifications/initialized',{});
  const sc=readJSON(SIDECAR)||{docs:{}}; const docs=sc.docs||{};
  const state=readJSON(STATE)||{docs:{}}; state.docs=state.docs||{};
  let targets=Object.entries(docs).filter(([rel,r])=>r&&r.docId);
  if(only) targets=targets.filter(([rel])=>rel===only);
  if(!targets.length){ console.log(only?('"'+only+'" not synced yet'):'no synced docs in sidecar'); proc.kill(); process.exit(0); }
  const uMap=await updatedAtMap();
  let baseline=0, clean=0, touched=0; const dirty=[];
  for(const [rel,r] of targets){
    const cur=uMap[r.docId]; if(!cur){ console.log('gone?     '+rel); continue; }
    const st=state.docs[rel];
    if(!st||CAPTURE){ const h=await exportHash(r.docId); state.docs[rel]={docId:r.docId,updatedAt:cur.updatedAt,exportHash:h,checkedAt:new Date().toISOString()}; baseline++; console.log('BASELINE  '+rel); continue; }
    if(cur.updatedAt===st.updatedAt){ clean++; continue; }
    const h=await exportHash(r.docId);
    if(h && h!==st.exportHash){ dirty.push(rel); state.docs[rel]={docId:r.docId,updatedAt:cur.updatedAt,exportHash:st.exportHash,dirtyExportHash:h,checkedAt:new Date().toISOString()}; console.log('DIRTY     '+rel+'   (content changed in AFFiNE -> sync-back candidate)'); }
    else { touched++; state.docs[rel].updatedAt=cur.updatedAt; console.log('touched   '+rel+'   (flushed, no content change)'); }
  }
  fs.writeFileSync(STATE, JSON.stringify(state,null,2));
  console.log('--- checked '+targets.length+': baseline='+baseline+'  clean='+clean+'  touched-no-change='+touched+'  DIRTY='+dirty.length+' ---');
  if(dirty.length) console.log('sync-back candidates: '+JSON.stringify(dirty.slice(0,30)));
  proc.kill(); process.exit(0);
}catch(e){console.error('FATAL',e.message);proc.kill();process.exit(1);} })();
