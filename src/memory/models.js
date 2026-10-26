export const embeddingModels=[
 {key:'multilingual',name:'Multilingual MiniLM · English, Czech and other languages',model:'Xenova/paraphrase-multilingual-MiniLM-L12-v2',revision:'2c4055b12046f11709e9df2c122e59ffbdc2f900',description:'Recommended for mixed-language teams. About 118 MB of model weights.'},
 {key:'english-small',name:'English MiniLM · smaller and faster',model:'Xenova/all-MiniLM-L6-v2',revision:'751bff37182d3f1213fa05d7196b954e230abad9',description:'For English project memory on smaller servers. About 23 MB of model weights.'}
];
export const retrievalDefaults={enabled:true,model:'multilingual',threads:2,minScore:0.25,contextChars:6000};

export const cloudflareModels=[{key:'@cf/baai/bge-m3',name:'BGE-M3 · multilingual',description:'Cloudflare-hosted multilingual embeddings. Indexed passages and queries are sent to Cloudflare.'}];
