// Workers cannot run the native local model. Do not upload memory to another service implicitly.
export function localEmbeddings(){return null;}
