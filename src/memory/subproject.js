// Resolve the parent independently for every read. An explicit link is not an
// authorization grant and cannot redirect a child write to another project.
export async function resolveParent(selected,discover,directory){
 if(!selected?.parent)return null;
 const binding=await discover(directory,{command:'resolve',cwd:selected.parent.root});
 if(binding.status!=='enrolled'||binding.room!==selected.parent.room||binding.workspace!==selected.workspace||binding.root!==selected.parent.root)throw Error('The linked parent project is unavailable or its binding changed.');
 return binding;
}

export function parentQuery(input){
 const {command,query,kinds,mode,includeArchived}=input;
 return {command,...(query!==undefined?{query}:{}),...(command==='search'&&kinds?{kinds}:{}),...(mode?{mode}:{}),...(includeArchived?{includeArchived:true}:{})};
}
