// Keep identifiers intact, but don't spend all 16 lexical terms on prompt boilerplate.
const stop=new Set('a an and are as at be been but by can could do does for from had has have how i if in is it its me my no not of on or our please should so some that the their them there these they this to us was we were what when where which why will with would you your se je na do pro že a jak proč co to ve v z s'.split(' '));
export function queryTokens(query){return [...new Set((query.match(/[\p{L}\p{N}_-]+/gu)??[]).filter(token=>!stop.has(token.toLowerCase())))].slice(0,16);}
