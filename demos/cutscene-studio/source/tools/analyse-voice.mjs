import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [engine,wave,cues,path]=process.argv.slice(2);
if(!path)throw new Error('Pass the verified Margo checkout, keeper.wav, keeper.json and output module.');
const pcm=readFileSync(wave);
if(pcm.toString('ascii',0,4)!=='RIFF'||pcm.toString('ascii',8,12)!=='WAVE')throw new Error('Expected a PCM RIFF file.');
let rate=0,data;
for(let at=12;at+8<=pcm.length;){
  const key=pcm.toString('ascii',at,at+4),length=pcm.readUInt32LE(at+4),begin=at+8;
  if(key==='fmt '){
    if(pcm.readUInt16LE(begin)!==1||pcm.readUInt16LE(begin+2)!==1||pcm.readUInt16LE(begin+14)!==16)
      throw new Error('Expected 16-bit mono PCM.');
    rate=pcm.readUInt32LE(begin+4);
  }else if(key==='data')data=pcm.subarray(begin,begin+length);
  at=begin+length+(length%2);
}
if(!rate||!data)throw new Error('PCM audio format or samples are absent.');
const samples=Float32Array.from({length:data.length/2},(_,index)=>data.readInt16LE(index*2)/32768);
const {analyseSpeech}=await import(pathToFileURL(resolve(engine,'packages/cutscene/dist/lipsync.js')));
const voice=JSON.parse(readFileSync(cues,'utf8'));
voice.phonemes=analyseSpeech(samples,rate).map(({time,end,phoneme,weight})=>({
  time:+time.toFixed(4),end:end===undefined?undefined:+end.toFixed(4),phoneme,
  weight:weight===undefined?undefined:+weight.toFixed(4),
}));
if(voice.phonemes.filter(key=>key.phoneme!=='sil').length<10)throw new Error('The phoneme analysis found too little speech.');
writeFileSync(path,'// Analysed from the keeper’s own synthesised dialogue with Margo Cutscene.\nexport const take='+JSON.stringify(voice)+';\n');
console.log(voice.duration,'seconds,',voice.phonemes.length,'phoneme keys');
