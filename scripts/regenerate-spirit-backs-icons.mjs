import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const env=Object.fromEntries((await fs.readFile('.env','utf8')).split(/\r?\n/).map(x=>x.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([,k,v])=>[k,v]));
const URL=env.PUBLIC_SUPABASE_URL, KEY=env.SUPABASE_SERVICE_ROLE_KEY, SCHEMA='arc_spirits_assets', BUCKET='game_assets';
const TAG='rework-2026-10-29-card-icons-v4'; const BASE='rework-2026-10-15/game-fit-v2';
const headers={apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'};
const pub=p=>`${URL}/storage/v1/object/public/${BUCKET}/${p}`; const obj=p=>`${URL}/storage/v1/object/${BUCKET}/${p}`;
async function get(pathname){const r=await fetch(`${URL}/rest/v1/${pathname}`,{headers:{...headers,'Accept-Profile':SCHEMA}});if(!r.ok)throw Error(`${pathname} ${r.status}`);return r.json()}
async function bytes(u){const r=await fetch(u);if(!r.ok)throw Error(`${u} ${r.status}`);return Buffer.from(await r.arrayBuffer())}
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
 layers.push({input:await sharp(base).extract({left:360,top:1260,width:900,height:620}).png().toBuffer(),left:360,top:1260});
 layers.push({input:await sharp(base).extract({left:600,top:1900,width:700,height:500}).png().toBuffer(),left:600,top:1900});
 const isHero=/^hero\b/i.test(row.name); const origin=originById.get(row.traits?.origin_ids?.[0]); if(!isHero && origin?.icon_token_png) layers.push({input:await sharp(await bytes(pub(origin.icon_token_png))).resize(360,360).png().toBuffer(),left:690,top:1975});
 const cls=(row.traits?.class_ids||[]).map(id=>classById.get(id)).filter(x=>x?.icon_png);
 const left=cls.length<=1?520:cls.length===2?430:340;
 for(let i=0;i<cls.length;i++){let icon=sharp(await bytes(pub(cls[i].icon_png))); icon=icon.negate({alpha:false}); layers.push({input:await icon.resize(300,300,{fit:'contain'}).png().toBuffer(),left:left+i*320,top:1390});}
 if(isHero && cls[0]) { const icon=sharp(await bytes(pub(cls[0].icon_png))).negate({alpha:false}); layers.push({input:await icon.resize(360,360,{fit:'contain'}).png().toBuffer(),left:690,top:1975}); }
 const output=await sharp(input).composite(layers).png({compressionLevel:9}).toBuffer(); const out=`hex_spirits/${row.id}/${TAG}/game-fit-v2/back.png`; await fs.writeFile(path.join('verification/card-icons',`${row.id}.png`),output);
 if(apply){let u=await fetch(obj(out),{method:'POST',headers:{...headers,'x-upsert':'true','cache-control':'31536000'},body:output});if(!u.ok)throw Error(`upload ${row.name}`);let p=await fetch(`${URL}/rest/v1/hex_spirits?id=eq.${row.id}`,{method:'PATCH',headers:{...headers,'Content-Profile':SCHEMA,Prefer:'return=minimal'},body:JSON.stringify({back_side_export:out})});if(!p.ok)throw Error(`patch ${row.name}`)}
 report.push({id:row.id,name:row.name,out})
}
console.log(JSON.stringify({apply,count:report.length,tag:TAG},null,2));
