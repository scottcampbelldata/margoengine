import sys,json,base64
from pathlib import Path
import onnx,onnxruntime as ort,numpy as np
cases=json.loads(Path(sys.argv[1]).read_text(encoding="utf8"));results=[]
for case in cases:
 try:
  model=onnx.load_model_from_string(base64.b64decode(case['model']))
  model=onnx.shape_inference.infer_shapes(model,strict_mode=True)
  for output in model.graph.output:
   if not output.type.HasField('tensor_type'):
    output.type.tensor_type.elem_type=1
  # Missing output shapes are deliberate; ORT performs shape inference itself.
  options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1;options.log_severity_level=3;options.graph_optimization_level=ort.GraphOptimizationLevel.ORT_DISABLE_ALL
  session=ort.InferenceSession(model.SerializeToString(),options,providers=['CPUExecutionProvider'])
  feeds={name:np.array(v['data'],dtype=onnx.helper.tensor_dtype_to_np_dtype(v['kind'])).reshape(v['shape']) for name,v in case['feeds'].items()}
  output=session.run(None,feeds)
  expected=[]
  for value in output:
   kind=onnx.helper.np_dtype_to_tensor_dtype(value.dtype)
   expected.append({'kind':kind,'shape':list(value.shape),'data':value.ravel().tolist() if kind==8 else base64.b64encode(value.tobytes()).decode()})
  results.append({'id':case['id'],'expected':expected})
 except Exception as error:
  results.append({'id':case['id'],'error':str(error)})
Path(sys.argv[2]).write_text(json.dumps({'onnx':onnx.__version__,'onnxruntime':ort.__version__,'numpy':np.__version__,'results':results}))
print(json.dumps({'cases':len(results),'oracleErrors':[r for r in results if 'error' in r]}))
