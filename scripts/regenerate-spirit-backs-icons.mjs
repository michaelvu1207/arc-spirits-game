import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const env=Object.fromEntries((await fs.readFile('.env','utf8')).split(/\r?\n/).map(x=>x.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([,k,v])=>[k,v]));
const URL=env.PUBLIC_SUPABASE_URL, KEY=env.SUPABASE_SERVICE_ROLE_KEY, SCHEMA='arc_spirits_assets', BUCKET='game_assets';
const TAG='rework-2026-10-30-card-icons-v15'; const BASE='rework-2026-10-15/game-fit-v2';
const headers={apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'};
const pub=p=>`${URL}/storage/v1/object/public/${BUCKET}/${p}`; const obj=p=>`${URL}/storage/v1/object/${BUCKET}/${p}`;
function originKind(name){const n=String(name??'').toLowerCase();if(['fire','fire region','lantern lights'].includes(n))return'fire';if(['mountain','mountain region','cyber city'].includes(n))return'mountain';return null;}
function replacementIcon(kind){if(kind==='fire')return Buffer.from(`<svg width="360" height="360" viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="f" x1="0" y1="1" x2=".7" y2="0"><stop stop-color="#ff321d"/><stop offset=".55" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ffe26b"/></linearGradient></defs><path d="M182 328c-73 0-118-43-118-102 0-44 28-72 61-111 18-21 29-44 34-79 43 32 60 67 57 105 19-12 33-31 35-54 39 37 67 86 67 137 0 62-51 104-136 104Z" fill="url(#f)" stroke="#32121b" stroke-width="12"/><path d="M177 292c-33 0-54-21-54-49 0-23 16-38 34-57 10-11 16-22 18-39 24 20 31 39 28 61 12-8 19-17 22-29 17 21 27 45 27 68 0 28-23 45-75 45Z" fill="#fff1a3" stroke="#8d2a21" stroke-width="8"/></svg>`);return Buffer.from(`<svg width="360" height="360" viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d8e0e9"/><stop offset=".5" stop-color="#8392a3"/><stop offset="1" stop-color="#394757"/></linearGradient></defs><path d="M40 294 62 172 138 94 230 121 318 224 290 306Z" fill="url(#r)" stroke="#17202c" stroke-width="12"/><path d="m62 172 76-78 20 113-66 52Z" fill="#f1f5f8" opacity=".8"/><path d="m158 207 72-86 88 103-91 17Z" fill="#aebdca"/><path d="m92 259 66-52 75 34-69 65Z" fill="#556576"/></svg>`);}
async function get(pathname){const r=await fetch(`${URL}/rest/v1/${pathname}`,{headers:{...headers,'Accept-Profile':SCHEMA}});if(!r.ok)throw Error(`${pathname} ${r.status}`);return r.json()}
async function bytes(u){const r=await fetch(u);if(!r.ok)throw Error(`${u} ${r.status}`);return Buffer.from(await r.arrayBuffer())}
async function cleanClassIcon(input){const r=await sharp(input).raw().toBuffer({resolveWithObject:true});const{width,height,channels}=r.info;const seen=new Uint8Array(width*height);const component=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const st=y*width+x;if(seen[st]||r.data[st*channels+3]<10)continue;component.length=0;const q=[st];seen[st]=1;let minX=x,maxX=x,minY=y,maxY=y;while(q.length){const p=q.pop(),px=p%width,py=Math.floor(p/width);component.push(p);minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);for(const[nx,ny]of[[px-1,py],[px+1,py],[px,py-1],[px,py+1]]){if(nx<0||ny<0||nx>=width||ny>=height)continue;const np=ny*width+nx;if(!seen[np]&&r.data[np*channels+3]>=10){seen[np]=1;q.push(np)}}}if((minX<=width*.12||maxX>=width*.88)&&maxX-minX<width*.34)for(const p of component)r.data[p*channels+3]=0;}return sharp(r.data,{raw:r.info}).png().toBuffer();}
async function clearIconEdges(input){const r=await sharp(input).raw().toBuffer({resolveWithObject:true});const{width,height,channels}=r.info;for(let y=0;y<height;y++)for(let x=0;x<width;x++){if(x>width*.18&&x<width*.82)continue;const i=(y*width+x)*channels;if(r.data[i]>205&&r.data[i+1]>205&&r.data[i+2]>205)r.data[i+3]=0;}return sharp(r.data,{raw:r.info}).png().toBuffer();}
const apply=process.argv.includes('--apply'); await fs.mkdir('verification/card-icons',{recursive:true});
const [rows, classes, origins]=await Promise.all([get('hex_spirits?select=id,name,traits,back_side_export'),get('classes?select=id,name,icon_png'),get('origins?select=id,name,icon_token_png')]);
const byId=new Map(rows.map(x=>[x.id,x])), classById=new Map(classes.map(x=>[x.id,x])), originById=new Map(origins.map(x=>[x.id,x]));
const ids=rows.map(x=>x.id); const report=[];
for(const row of rows){
 const source=row.back_side_export || `hex_spirits/${row.id}/${BASE}/back.png`;
 let input=await bytes(pub(source)); const base=await bytes(pub(`hex_spirits/${row.id}/${BASE}/back-base.png`)); const layers=[];
 // Clear the legacy class/origin token artwork before placing the current
 // catalog tokens. This prevents duplicate icons when an older export already
 // contains a token in a different slot.
 layers.push({input:await sharp(base).extract({left:250,top:1150,width:1200,height:850}).png().toBuffer(),left:250,top:1150});
 layers.push({input:await sharp(base).extract({left:500,top:1850,width:900,height:560}).png().toBuffer(),left:500,top:1850});
 const isHero=/^hero\b/i.test(row.name); const origin=originById.get(row.traits?.origin_ids?.[0]); const hideOrigin=isHero || /arcane spirits|sun|moon|astral|void/i.test(origin?.name ?? ''); const kind=originKind(origin?.name); const showBottomOrigin=['fire','forest','mountain','water'].includes(String(origin?.name ?? '').toLowerCase()); if(!hideOrigin && showBottomOrigin && origin) { const originBytes=kind?replacementIcon(kind):await bytes(pub(origin.icon_token_png)); layers.push({input:await sharp(originBytes).resize(360,360).png().toBuffer(),left:690,top:1975}); }
 const cls=(row.traits?.class_ids||[]).map(id=>classById.get(id)).filter(x=>x?.icon_png);
 const left=cls.length<=1?520:cls.length===2?430:340;
 for(let i=0;i<cls.length;i++){let icon=sharp(await cleanClassIcon(await bytes(pub(cls[i].icon_png)))); icon=icon.negate({alpha:false}); layers.push({input:await clearIconEdges(await icon.resize(300,300,{fit:'contain'}).png().toBuffer()),left:left+i*320,top:1390});}
 const output=await sharp(input).composite(layers).png({compressionLevel:9}).toBuffer(); const out=`hex_spirits/${row.id}/${TAG}/game-fit-v2/back.png`; await fs.writeFile(path.join('verification/card-icons',`${row.id}.png`),output);
 if(apply){let u=await fetch(obj(out),{method:'POST',headers:{...headers,'x-upsert':'true','cache-control':'31536000'},body:output});if(!u.ok)throw Error(`upload ${row.name}`);let p=await fetch(`${URL}/rest/v1/hex_spirits?id=eq.${row.id}`,{method:'PATCH',headers:{...headers,'Content-Profile':SCHEMA,Prefer:'return=minimal'},body:JSON.stringify({back_side_export:out})});if(!p.ok)throw Error(`patch ${row.name}`)}
 report.push({id:row.id,name:row.name,out})
}
console.log(JSON.stringify({apply,count:report.length,tag:TAG},null,2));
