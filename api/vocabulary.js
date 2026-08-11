function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store'
    }
  });
}

function extractOutputText(data){
  if(typeof data?.output_text==='string' && data.output_text.trim()) return data.output_text;
  const parts=[];
  for(const item of (data?.output||[])){
    for(const c of (item?.content||[])){
      if(typeof c?.text==='string') parts.push(c.text);
      else if(typeof c?.text?.value==='string') parts.push(c.text.value);
    }
  }
  return parts.join('\n').trim();
}

function parseJsonText(text){
  const clean=String(text||'')
    .replace(/^```json\s*/i,'')
    .replace(/^```\s*/,'')
    .replace(/```$/,'')
    .trim();
  return JSON.parse(clean);
}

export default {
  async fetch(request){
    if(request.method!=='POST') return json({error:'METHOD_NOT_ALLOWED'},405);

    try{
      const body=await request.json().catch(()=>({}));
      const topic=String(body.topic||'').trim();
      const program=String(body.program||'SpeakHub').trim();

      if(!topic) return json({error:'TOPIC_REQUIRED'},400);

      const key=process.env.OPENAI_API_KEY;
      if(!key) return json({error:'OPENAI_API_KEY_MISSING'},500);

      const model=process.env.OPENAI_PLACEMENT_MODEL || 'gpt-5-mini';

      const prompt=`You create practical vocabulary for an offline English speaking club in Vietnam.

Class: ${program}
Topic: ${topic}

Return exactly 10 useful vocabulary items that students can actively use in discussion.
Adapt difficulty to the class name:
- Kid Starter: very simple everyday words/short phrases.
- Kid Communicator: simple but expressive speaking vocabulary.
- Adult Beginner: common, practical conversational English.
- Adult Intermediate: natural discussion vocabulary, useful collocations and phrases, but not overly academic.

For each item provide:
- word: English word, phrase, or collocation
- part_of_speech: short label such as noun, verb, adjective, phrase, collocation
- pronunciation: simple IPA when useful; otherwise empty string
- vietnamese: concise Vietnamese meaning
- example: one natural English example sentence directly related to the topic

Avoid obscure vocabulary. Avoid duplicate meanings. Make the list immediately useful for speaking.

Return ONLY valid JSON in this exact shape:
{"items":[{"word":"","part_of_speech":"","pronunciation":"","vietnamese":"","example":""}]}`;

      const response=await fetch('https://api.openai.com/v1/responses',{
        method:'POST',
        headers:{
          'authorization':`Bearer ${key}`,
          'content-type':'application/json'
        },
        body:JSON.stringify({
          model,
          input:prompt,
          max_output_tokens:1800
        })
      });

      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        console.error('vocabulary openai error',data);
        return json({
          error:'OPENAI_VOCABULARY_FAILED',
          details:data?.error?.message||'OpenAI request failed'
        },502);
      }

      const text=extractOutputText(data);
      const parsed=parseJsonText(text);
      const items=Array.isArray(parsed?.items)?parsed.items.slice(0,10):[];

      return json({topic,program,items});
    }catch(error){
      console.error('vocabulary api error',error);
      return json({
        error:'VOCABULARY_API_ERROR',
        details:String(error?.message||error)
      },500);
    }
  }
};
