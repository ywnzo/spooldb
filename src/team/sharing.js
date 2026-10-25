import {validMemoryEvent} from '../memory/event-validation.js';
const kindCategories=new Map(Object.entries({task:'tasks',handoff:'handoffs',finding:'findings',blocker:'findings',decision:'decisions'}));
import {fail} from '../relay/wire.js';
export const sharingCategories=['handoffs','decisions','findings','tasks','conversations'];
export const defaultSharing=()=>Object.fromEntries(sharingCategories.map(key=>[key,true]));
export const memoryCategory=input=>input.command==='task_update'?'tasks':input.command==='handoff'?'handoffs':input.command==='remember'?kindCategories.get(input.kind):null;
export function recordCategory(record){let event;try{event=JSON.parse(record.text);}catch{}return record.role==='system'&&validMemoryEvent(event)?(kindCategories.get(event.kind)??'conversations'):'conversations';}
export const conversationExcerpt=input=>typeof input.text==='string'&&(input.text.startsWith('Current request (source text, not verified findings):\n')||input.text.startsWith('Automatic lifecycle checkpoint; agent-authored next steps and verification were not supplied.'));
export const blockedCategory=(input,sharing)=>sharing.conversations===false&&conversationExcerpt(input)?'conversations':sharing[memoryCategory(input)]===false?memoryCategory(input):null;
export function recordBlocked(record,sharing){let event;try{event=JSON.parse(record.text);}catch{}return sharing[recordCategory(record)]===false||sharing.conversations===false&&event?.protocol==='spool-memory/1'&&conversationExcerpt(event);}
export function assertSharing(input,sharing){const category=blockedCategory(input,sharing);fail(!category,'SHARING_DISABLED',`Sharing is off for ${category}. This item was not saved to the relay.`,403);}

export function sharedMemoryInput(input,sharing){assertSharing(input,sharing);if(sharing.tasks===false&&memoryCategory(input)&&memoryCategory(input)!=='tasks'){const value={...input};delete value.taskId;return value;}return input;}
