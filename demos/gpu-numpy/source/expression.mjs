const mathematicalNames=['A','B','signal','samples'];
const binaryPrecedence={'+':1,'-':1,'*':2,'/':2,'@':2};
const arity={
  abs:1,cos:1,fft:1,ifft:1,log:1,magnitude:1,matmul:2,max:1,mean:1,min:1,
  sin:1,sort:1,sqrt:1,square:1,sum:1,transpose:1,
};
const maxText=1000,maxTokens=512,maxDepth=48;

export class ExpressionError extends Error {
  constructor(message,column){
    super(message+' at character '+(column+1)+'.');
    this.name='ExpressionError';
    this.column=column;
  }
}

function tokenize(source){
  if(source.length>maxText)throw new ExpressionError('Keep the expression within '+maxText+' characters',maxText);
  const word=/\s*(?:(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?|([A-Za-z][A-Za-z0-9_]*)|([()[\],+\-*/@]))/y;
  const tokens=[];
  for(let index=0;index<source.length;){
    word.lastIndex=index;
    const match=word.exec(source);
    if(!match){
      if(/\S/.test(source.slice(index)))throw new ExpressionError('Unknown symbol',index+(source.slice(index).match(/^\s*/)?.[0].length??0));
      break;
    }
    const column=word.lastIndex-match[0].trimStart().length;
    if(tokens.length>=maxTokens)throw new ExpressionError('Expression has too many tokens',column);
    if(match[1]){
      const number=Number(match[1]+(match[2]??''));
      if(!Number.isFinite(number)||Math.abs(number)>1e14)throw new ExpressionError('Literal is outside the supported numerical range',column);
      tokens.push({type:'number',number,column});
    }else{
      tokens.push({type:match[4]??'name',word:match[3],column});
    }
    index=word.lastIndex;
  }
  tokens.push({type:'end',column:source.length});
  return tokens;
}

export function parseExpression(source){
  const tokens=tokenize(source);
  let cursor=0;
  const look=()=>tokens[cursor];
  const consume=()=>tokens[cursor++];
  function expect(type,label){
    const token=look();
    if(token.type!==type)throw new ExpressionError(label,token.column);
    return consume();
  }

  function array(depth){
    if(depth>2)throw new ExpressionError('An array literal supports two dimensions',look().column);
    const open=expect('[','Expected a list');
    const children=[];
    let matrix=null;
    do{
      const childIsRow=look().type==='[';
      if(matrix===null)matrix=childIsRow;
      if(childIsRow!==matrix)throw new ExpressionError('Use a rectangular matrix or a single vector',look().column);
      if(matrix){
        children.push(array(depth+1));
      }else{
        let sign=1;
        if(look().type==='-'||look().type==='+')sign=consume().type==='-'?-1:1;
        children.push(sign*expect('number','Expected a number').number);
      }
      if(look().type!==',')break;
      consume();
    }while(look().type!==']');
    expect(']','Expected ]');
    if(!matrix)return {type:'array',shape:[children.length],values:children};
    if(children.some(row=>row.shape.length!==1||row.shape[0]!==children[0].shape[0]))
      throw new ExpressionError('Matrix rows must have equal length',open.column);
    return {type:'array',shape:[children.length,children[0].shape[0]],values:children.flatMap(row=>row.values)};
  }

  function atom(depth){
    if(depth>maxDepth)throw new ExpressionError('Expression is nested too deeply',look().column);
    const next=look();
    if(next.type==='number'){consume();return {type:'constant',value:next.number};}
    if(next.type==='[')return array(1);
    if(next.type==='-'||next.type==='+'){
      consume();
      const value=atom(depth+1);
      return next.type==='+'?value:{type:'unary',value};
    }
    if(next.type==='('){
      consume();
      const value=expression(1,depth+1);
      expect(')','Expected )');
      return value;
    }
    if(next.type==='name'){
      consume();
      const name=next.word;
      if(look().type!=='('){
        if(!mathematicalNames.includes(name))throw new ExpressionError('Unknown array '+name,next.column);
        return {type:'name',name};
      }
      if(!Object.hasOwn(arity,name))throw new ExpressionError('Unknown operation '+name,next.column);
      consume();
      const args=[];
      while(look().type!==')'){
        args.push(expression(1,depth+1));
        if(look().type!==',')break;
        consume();
        if(look().type===')')throw new ExpressionError('Expected an argument',look().column);
      }
      expect(')','Expected )');
      if(args.length!==arity[name])throw new ExpressionError(name+' expects '+arity[name]+' argument'+(arity[name]===1?'':'s'),next.column);
      return {type:'call',name,args};
    }
    throw new ExpressionError('Expected a number, array, or expression',next.column);
  }

  function expression(minimum,depth){
    let left=atom(depth);
    while((binaryPrecedence[look().type]??0)>=minimum){
      const {type:operator}=consume();
      const right=expression(binaryPrecedence[operator]+1,depth+1);
      left={type:'binary',operator,left,right};
    }
    return left;
  }
  const result=expression(1,0);
  expect('end','Unexpected token');
  return result;
}
