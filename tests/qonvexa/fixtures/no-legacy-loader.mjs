// Test-only import tripwire. Catches unexpected legacy loading before it can act.
export async function resolve(specifier,context,nextResolve){
 if(/^(redis|pg|@langchain\/langgraph-checkpoint-postgres)(\/|$)/.test(specifier))throw Error('Forbidden legacy database dependency import');
 const result=await nextResolve(specifier,context);
 if(result.url.includes('/src/autonomos/'))throw Error('Forbidden legacy runtime import');
 return result;
}
