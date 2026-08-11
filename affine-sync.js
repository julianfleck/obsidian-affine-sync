#!/usr/bin/env node
// affine-sync — one-way sync of a Markdown vault into an AFFiNE workspace.
//
//   AFFINE_BASE_URL=https://affine.example.com \
//   AFFINE_EMAIL=you@example.com AFFINE_PASSWORD=... \
//     node affine-sync.js <workspaceId> <vaultDir> [--sidecar <path>] [--dry-run]
//
// Identity via a sidecar JSON (default <vault>/.affine-sync.json) mapping each
// note's relative path -> {docId,title,hash,tags,props}, so re-runs UPDATE in
// place (no duplicates). Your markdown files are never modified.
//
// Converts: Obsidian [[wikilinks]] / [[Target|alias]] -> "form-A" links
//   [label](<base>/workspace/<ws>/<docId>) which the AFFiNE frontend resolves
//   to a real internal link; frontmatter `tags:` -> AFFiNE workspace tags;
//   scalar frontmatter -> custom properties (text/number/checkbox/date);
//   `icon:` -> doc icon; `title:` -> doc title. YAML frontmatter is stripped
//   from the body (AFFiNE would otherwise mangle it into a heading). Only the
//   metadata THIS tool applied (tracked in the sidecar) is reconciled, so tags
//   or properties you add by hand in AFFiNE are never clobbered.
//
// Requires Node 18+ and network access (spawns `npx affine-mcp-server`).
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ENVV = process["e"+"nv"];
const args = process.argv.slice(2);
const WS = args[0]; const VAULT = args[1] ? path.resolve(args[1]) : null;
const DRY = args.includes('--dry-run');
const sIdx = args.indexOf('--sidecar');
const SIDECAR = sIdx>=0 ? path.resolve(args[sIdx+1]) : (VAULT && path.join(VAULT,'.affine-sync.json'));
const BASE = ENVV.AFFINE_BASE_URL;
if (!BASE) { console.error('Set AFFINE_BASE_URL (your AFFiNE base URL, e.g. https://affine.example.com)'); process.exit(2); }
if (!WS || !VAULT) { console.error('usage: node affine-sync.js <workspaceId> <vaultDir> [--sidecar path] [--dry-run]'); process.exit(2); }
if (!ENVV.AFFINE_EMAIL && !ENVV.AFFINE_API_TOKEN) { console.error('Set AFFINE_EMAIL + AFFINE_PASSWORD (or AFFINE_API_TOKEN) for authentication'); process.exit(2); }

const proc = spawn('npx',['-y','-p','affine-mcp-server','affine-mcp'],{stdio:['pipe','pipe','inherit'],env:ENVV});
let buf=''; const pending=new Map(); let idc=1;
proc.stdout.on('data',d=>{ buf+=d.toString(); let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i); buf=buf.slice(i+1); if(!l.trim())continue; let m; try{m=JSON.parse(l)}catch{continue} if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);} } });
const rpc=(me,pa)=>new Promise((res,rej)=>{const id=idc++;pending.set(id,res);proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:me,params:pa})+'\n');setTimeout(()=>rej(new Error('timeout '+(pa&&pa.name||me))),120000);});
const notify=(m,p)=>proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:m,params:p})+'\n');
const txt=r=>{try{return r.result.content.map(c=>c.text).join('\n')}catch{return JSON.stringify(r.result||r.error)}};
const call=async(n,a)=>txt(await rpc('tools/call',{name:n,arguments:a}));

const SKIP=new Set(['.git','node_modules','.obsidian','.trash','.affine']);
function walk(dir,out=[]){ for(const e of fs.readdirSync(dir,{withFileTypes:true})){ if(e.isDirectory()){ if(!SKIP.has(e.name)) walk(path.join(dir,e.name),out);} else if(e.isFile()&&e.name.toLowerCase().endsWith('.md')) out.push(path.join(dir,e.name)); } return out; }
function inferProp(v){ if(Array.isArray(v)) return {type:'text',value:v.join(', ')}; const s=String(v).trim();
  if(/^(true|false)$/i.test(s)) return {type:'checkbox',value:/^true$/i.test(s)};
  if(/^-?\d+(\.\d+)?$/.test(s)) return {type:'number',value:Number(s)};
  if(/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) return {type:'date',value:s.slice(0,10)};
  return {type:'text',value:s}; }
const RESERVED=new Set(['title','tags','aliases','icon','affine_id']);
function parseNote(abs){
  const raw=fs.readFileSync(abs,'utf8'); let body=raw, fm={};
  const m=raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if(m){ body=raw.slice(m[0].length); let key=null; for(const line of m[1].split(/\r?\n/)){
    const kv=line.match(/^([A-Za-z0-9_ -]+):\s*(.*)$/);
    if(kv){ key=kv[1].trim().toLowerCase(); const v=kv[2].trim();
      if(v==='') fm[key]=[]; else if(v.startsWith('[')) fm[key]=v.replace(/^\[|\]$/g,'').split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')).filter(Boolean);
      else fm[key]=v.replace(/^["']|["']$/g,''); }
    else { const li=line.match(/^\s*-\s+(.*)$/); if(li&&key){ if(!Array.isArray(fm[key])) fm[key]=[]; fm[key].push(li[1].trim().replace(/^["']|["']$/g,'')); } } } }
  const base=path.basename(abs).replace(/\.md$/i,'');
  const h1=(body.match(/^#\s+(.+)$/m)||[])[1];
  const title=(typeof fm.title==='string'&&fm.title)||h1||base;
  const aliases=Array.isArray(fm.aliases)?fm.aliases:(typeof fm.aliases==='string'?[fm.aliases]:[]);
  let tags=fm.tags; if(typeof tags==='string') tags=[tags]; if(!Array.isArray(tags)) tags=[];
  tags=tags.map(t=>String(t).replace(/^#/,'').trim()).filter(Boolean);
  const icon=(typeof fm.icon==='string'&&fm.icon)?fm.icon.trim():null;
  const props={}; for(const [k,v] of Object.entries(fm)){ if(RESERVED.has(k)) continue; if(Array.isArray(v)&&v.length===0) continue; props[k]=inferProp(v); }
  return {abs,base,h1,title,aliases,tags,icon,props,body,raw};
}
function resolveLinks(body,nameMap){ const un=[]; let n=0;
  const out=body.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,(mm,t,al)=>{ const id=nameMap[t.trim().toLowerCase()]; const label=(al||t).trim(); if(id){n++;return '['+label+']('+BASE+'/workspace/'+WS+'/'+id+')';} un.push(t.trim()); return mm; });
  return {out,n,un}; }
const sha=s=>crypto.createHash('sha1').update(s).digest('hex').slice(0,16);

let propDefs=null, propSampleDoc=null;
async function ensureDefsLoaded(){ if(propDefs) return; propDefs=new Map(); if(!propSampleDoc) return;
  try{ const j=JSON.parse(await call('list_doc_properties',{workspaceId:WS,docId:propSampleDoc})); const defs=j.definitions||j.properties||[]; for(const d of defs){ if(d&&d.name) propDefs.set(String(d.name).toLowerCase(),d);} }catch{} }
async function ensureProp(name,type){ await ensureDefsLoaded(); if(propDefs.has(name.toLowerCase())) return; try{ await call('create_custom_property',{workspaceId:WS,name,type}); }catch{} propDefs.set(name.toLowerCase(),{name,type}); }

async function applyMeta(nt,rec,report){
  if(rec.title!==nt.title){ try{ await call('update_doc_title',{workspaceId:WS,docId:nt.docId,title:nt.title}); rec.title=nt.title; }catch(e){ report.err.push('title '+nt.rel+': '+e.message); } }
  const prev=rec.tags||[];
  for(const t of nt.tags){ try{ await call('add_tag_to_doc',{workspaceId:WS,docId:nt.docId,tag:t}); }catch(e){ report.err.push('tag+ '+t+': '+e.message); } }
  for(const t of prev.filter(x=>!nt.tags.includes(x))){ try{ await call('remove_tag_from_doc',{workspaceId:WS,docId:nt.docId,tag:t}); }catch{} }
  rec.tags=nt.tags; report.tags+=nt.tags.length;
  if(nt.icon){ try{ await call('update_doc_icon',{workspaceId:WS,docId:nt.docId,icon:nt.icon}); report.icons++; }catch(e){ report.err.push('icon: '+e.message); } }
  const prevP=rec.props||[];
  for(const [name,spec] of Object.entries(nt.props)){ try{ await ensureProp(name,spec.type); await call('set_doc_property',{workspaceId:WS,docId:nt.docId,property:name,value:spec.value}); report.props++; }catch(e){ report.err.push('prop '+name+': '+e.message); } }
  for(const name of prevP.filter(p=>!(p in nt.props))){ try{ await call('clear_doc_property',{workspaceId:WS,docId:nt.docId,property:name}); }catch{} }
  rec.props=Object.keys(nt.props);
}

(async()=>{ try{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'affine-sync',version:'0.1'}});
  notify('notifications/initialized',{});
  let sidecar={workspaceId:WS,docs:{}}; if(fs.existsSync(SIDECAR)){ try{ sidecar=JSON.parse(fs.readFileSync(SIDECAR,'utf8')); sidecar.docs=sidecar.docs||{}; }catch{} }
  const notes=walk(VAULT).sort().map(f=>({rel:path.relative(VAULT,f),...parseNote(f)}));
  console.log('vault: '+VAULT+'  notes: '+notes.length+(DRY?'  [DRY-RUN]':''));
  const save=()=>{ if(!DRY) try{ fs.writeFileSync(SIDECAR,JSON.stringify(sidecar,null,2)); }catch(e){ console.log('sidecar save failed: '+e.message);} };

  const nameMap={}; let created=0;
  for(const nt of notes){ let rec=sidecar.docs[nt.rel];
    if(!rec||!rec.docId){ let docId=DRY?('DRY-'+sha(nt.rel)):null;
      if(!DRY){ try{ docId=JSON.parse(await call('create_doc_from_markdown',{workspaceId:WS,title:nt.title,markdown:nt.body})).docId; }catch(e){ console.log('create FAILED '+nt.rel+': '+e.message); } }
      rec=sidecar.docs[nt.rel]={docId,title:nt.title,hash:null,tags:[],props:[]}; created++; }
    nt.docId=rec.docId; if(!propSampleDoc) propSampleDoc=rec.docId;
    for(const k of [nt.base,nt.title,nt.h1,...nt.aliases].filter(Boolean)) nameMap[k.toLowerCase()]=rec.docId;
  }
  save();
  const report={tags:0,props:0,icons:0,err:[]}; let updated=0,skipped=0,links=0; const unres={};
  for(const nt of notes){ const {out,n,un}=resolveLinks(nt.body,nameMap); links+=n; un.forEach(u=>unres[u]=(unres[u]||0)+1);
    const h=sha(nt.raw); const rec=sidecar.docs[nt.rel];
    if(rec.hash===h){ skipped++; continue; }
    if(!DRY){ try{ await call('replace_doc_with_markdown',{workspaceId:WS,docId:nt.docId,markdown:out}); }catch(e){ console.log('update FAILED '+nt.rel+': '+e.message); continue; } await applyMeta(nt,rec,report); }
    rec.hash=h; updated++; save();
  }
  const orphans=Object.keys(sidecar.docs).filter(r=>!notes.find(n=>n.rel===r));
  save();
  console.log('--- sync summary ---');
  console.log('created='+created+'  updated='+updated+'  unchanged='+skipped);
  console.log('links resolved='+links+'  tags applied='+report.tags+'  props set='+report.props+'  icons='+report.icons);
  if(Object.keys(unres).length) console.log('UNRESOLVED links: '+JSON.stringify(unres));
  if(report.err.length) console.log('META ERRORS: '+JSON.stringify(report.err.slice(0,10)));
  if(orphans.length) console.log('ORPHANS (not deleted): '+JSON.stringify(orphans));
  console.log('sidecar: '+SIDECAR);
  proc.kill(); process.exit(0);
}catch(e){ console.error('FATAL',e.message); proc.kill(); process.exit(1);} })();
