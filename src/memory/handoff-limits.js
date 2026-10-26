import {fail} from '../relay/wire.js';

export const handoffLimits={title:120,text:1500,items:3,itemChars:160,total:2000};
export const handoffGuidance='Keep title, summary, next steps and blockers within 2,000 characters combined (summary at most 1,500; title 120; at most 3 next steps and 3 blockers, 160 characters each). Aim for a short status, essential validation and the next action. Save detailed evidence/runbooks as separate findings or decisions and cite their IDs in refs. Do not repeat the conversation or split one recap across multiple handoffs.';
const length=value=>[...value].length;
export const handoffLength=input=>length([input.title,input.text,...(input.nextSteps??[]),...(input.blockers??[])].join('\n'));
export function assertHandoff(input){
 fail(typeof input.title==='string'&&typeof input.text==='string'&&[input.nextSteps??[],input.blockers??[]].every(list=>Array.isArray(list)&&list.every(item=>typeof item==='string')),'HANDOFF_FORMAT','Handoff title, summary and action lists must contain text');
 const total=handoffLength(input);
 fail(length(input.title)<=handoffLimits.title&&length(input.text)<=handoffLimits.text&&[input.nextSteps??[],input.blockers??[]].every(list=>list.length<=handoffLimits.items&&list.every(item=>length(item)<=handoffLimits.itemChars))&&total<=handoffLimits.total,'HANDOFF_TOO_LONG',`Handoff is too long (${total} characters combined). ${handoffGuidance}`);
}
