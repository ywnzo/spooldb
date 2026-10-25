import {cpSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';

// Walk the installed production graph, preserving hoisted and nested package paths.
// This works offline in both a source checkout and an already bundled application.
export function copyProductionDependencies(source,destination,{exclude=[]}={}){
 source=resolve(source);destination=resolve(destination);
 const visited=new Set(),overrides=JSON.parse(readFileSync(join(source,'package.json'),'utf8')).overrides??{};
 function visit(directory){
  const manifest=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
  const optional=manifest.optionalDependencies??{};
  for(const name of new Set([...Object.keys(manifest.dependencies??{}),...Object.keys(optional)])){
   if(exclude.includes(name))continue;
   if(!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)||name==='.'||name==='..')throw Error('Invalid dependency name');
   let base=directory,dependency;
   while(base===source||base.startsWith(source+'/')){
    const candidate=join(base,'node_modules',name);
    if(existsSync(join(candidate,'package.json'))){dependency=candidate;break;}
    if(base===source)break;
    base=dirname(base);
   }
   if(!dependency){if(name in optional)continue;throw Error('Missing production dependency: '+name);}
   const expected=overrides[name]??manifest.dependencies?.[name]??optional[name],installed=JSON.parse(readFileSync(join(dependency,'package.json'),'utf8'));
   if(typeof expected==='string'&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expected)&&installed.version!==expected)throw Error('Installed dependency '+name+' does not match pinned version '+expected+'. Reinstall dependencies before packaging.');
   if(visited.has(dependency))continue;
   visited.add(dependency);
   const target=join(destination,relative(source,dependency));
   mkdirSync(dirname(target),{recursive:true});
   cpSync(dependency,target,{recursive:true,filter:path=>relative(dependency,path).split('/')[0]!=='node_modules'});
   visit(dependency);
  }
 }
 visit(source);
 return [...visited].map(path=>relative(source,path));
}
