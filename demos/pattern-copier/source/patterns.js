export const size=12;
export const width=48;
export const height=36;
export const initial='ledger';
export const firstSeed=41;
export const colors=[
  {name:'Parchment',color:'#dbcba9',rgb:[219,203,169]},
  {name:'Indigo',color:'#233845',rgb:[35,56,69]},
  {name:'Saffron',color:'#d09d51',rgb:[208,157,81]},
  {name:'Madder',color:'#a4523c',rgb:[164,82,60]},
  {name:'Celadon',color:'#668469',rgb:[102,132,105]},
];
const samples={
  ledger:[
    '111111111111',
    '111211114111',
    '112021140411',
    '120202404041',
    '112021140411',
    '111211114111',
    '111111111111',
    '111311112111',
    '113031120211',
    '130303202021',
    '113031120211',
    '111311112111',
  ],
  selvedge:[
    '001000010000',
    '012100121000',
    '120210202100',
    '202012021210',
    '020120210202',
    '001041010020',
    '010404100010',
    '104000410000',
    '010404100031',
    '001041000303',
    '000100003030',
    '000000000300',
  ],
  basket:[
    '444444444444',
    '400043334004',
    '401040304014',
    '400043334004',
    '444444444444',
    '422241114224',
    '420241014204',
    '422241114224',
    '444444444444',
    '433340004334',
    '430340104304',
    '433340004334',
  ],
};
export function sample(id){
  const rows=samples[id];
  return rows?Uint8Array.from(rows.join(''),letter=>Number(letter)):new Uint8Array(size*size);
}
