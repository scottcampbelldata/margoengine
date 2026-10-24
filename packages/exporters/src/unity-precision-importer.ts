// Unity Editor C# that imports an exact static precision bundle through the official glTFast importer.
import { type NativeAppNames, nativeAppNames, nativeExtension } from './native-names.js';

/** Options for {@link createUnityPrecisionImporter}. */
export interface UnityPrecisionImporterOptions {
  /** The owning application: names the C# namespace (`<appName>Precision`), menu, folders and log lines. */
  appName: string;
  /** The bundle manifest's file extension, without the dot, offered by the Editor's open dialog. */
  extension: string;
}

/**
 * The helper's C# `OriginalJsonPresence` class: token presence, type and duplicate-key checks over the original glTF
 * JSON, which Unity's JsonUtility cannot tell from defaults. Exported so it can be compiled and tested on its own.
 */
export const UNITY_PRECISION_JSON_PRESENCE = String.raw`
    static class OriginalJsonPresence {
        static bool Space(char value) => value==' ' || value=='\t' || value=='\r' || value=='\n';
        // The framework reader accepts trailing roots/commas and some non-JSON
        // number spellings. This allocation-bounded grammar pass prevents those
        // aliases; decoded member identity and types still come from its tokens.
        sealed class JsonBoundary {
            readonly string text;int at;
            public JsonBoundary(string value){text=value;}
            void Whitespace(){while(at<text.Length && Space(text[at]))at++;}
            bool Take(char value){if(at<text.Length && text[at]==value){at++;return true;}return false;}
            void Required(char value){Need(Take(value),"Original JSON strict delimiter");}
            bool Digit()=>at<text.Length && text[at]>='0' && text[at]<='9';
            void Quoted(){
                Required('"');bool closed=false;
                while(at<text.Length){char value=text[at++];if(value=='"'){closed=true;break;}Need(value>=32,"Original JSON unescaped control character");if(value!='\\')continue;
                    Need(at<text.Length,"Original JSON complete escape");char escape=text[at++];
                    if(escape=='u'){for(int i=0;i<4;i++){Need(at<text.Length && Uri.IsHexDigit(text[at]),"Original JSON unicode escape");at++;}}
                    else Need(escape=='"'||escape=='\\'||escape=='/'||escape=='b'||escape=='f'||escape=='n'||escape=='r'||escape=='t',"Original JSON escape spelling");
                }
                Need(closed,"Original JSON complete string");
            }
            void Numeric(){
                Take('-');Need(Digit(),"Original JSON numeric spelling");
                if(!Take('0')){Need(at<text.Length && text[at]>='1' && text[at]<='9',"Original JSON integer spelling");while(Digit())at++;}
                if(Take('.')){Need(Digit(),"Original JSON fraction spelling");while(Digit())at++;}
                if(Take('e')||Take('E')){if(!Take('+'))Take('-');Need(Digit(),"Original JSON exponent spelling");while(Digit())at++;}
            }
            void Literal(string value){Need(at+value.Length<=text.Length && String.CompareOrdinal(text,at,value,0,value.Length)==0,"Original JSON literal spelling");at+=value.Length;}
            void Value(int depth){
                Need(depth<=128,"Original JSON bounded nesting");Whitespace();Need(at<text.Length,"Original JSON complete value");char value=text[at];
                if(value=='{'){at++;Whitespace();if(Take('}'))return;while(true){Quoted();Whitespace();Required(':');Value(depth+1);Whitespace();if(Take('}'))return;Required(',');Whitespace();}}
                if(value=='['){at++;Whitespace();if(Take(']'))return;while(true){Value(depth+1);Whitespace();if(Take(']'))return;Required(',');Whitespace();}}
                if(value=='"'){Quoted();return;}if(value=='t'){Literal("true");return;}if(value=='f'){Literal("false");return;}if(value=='n'){Literal("null");return;}Numeric();
            }
            public void Validate(){Whitespace();Need(at<text.Length && text[at]=='{',"Original JSON root object boundary");Value(1);Whitespace();Need(at==text.Length,"Original JSON complete single root");}
        }
        static string Kind(System.Xml.Linq.XElement value) => (string)value.Attribute("type");
        static string Name(System.Xml.Linq.XElement value) => (string)value.Attribute("item") ?? value.Name.LocalName;
        static System.Xml.Linq.XElement Member(System.Xml.Linq.XElement owner,string name,string kind,bool required=true) {
            var value=owner.Elements().SingleOrDefault(e=>Name(e)==name);
            Need(value!=null || !required,"Original JSON required member: "+name);
            if(value!=null) Need(Kind(value)==kind,"Original JSON member type: "+name+" expected "+kind);
            return value;
        }
        static void Number(System.Xml.Linq.XElement owner,string name,bool required=true,bool integer=true) {
            var value=Member(owner,name,"number",required);if(value==null)return;
            Need(Double.TryParse(value.Value,System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out double n) && !Double.IsInfinity(n) && !Double.IsNaN(n) && (!integer || (n==Math.Truncate(n) && n>=Int32.MinValue && n<=Int32.MaxValue)),"Original JSON finite numeric representation: "+name);
        }
        static void Numbers(System.Xml.Linq.XElement owner,string name,bool required=false,bool integer=false) {
            var value=Member(owner,name,"array",required);if(value==null)return;
            foreach(var item in value.Elements()) {
                Need(Kind(item)=="number" && Double.TryParse(item.Value,System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out double n) && !Double.IsInfinity(n) && !Double.IsNaN(n) && (!integer || (n==Math.Truncate(n) && n>=Int32.MinValue && n<=Int32.MaxValue)),"Original JSON numeric array: "+name);
            }
        }
        static System.Xml.Linq.XElement[] Objects(System.Xml.Linq.XElement owner,string name) {
            var values=Member(owner,name,"array").Elements().ToArray();
            Need(values.All(value=>Kind(value)=="object"),"Original JSON object array: "+name);return values;
        }
        static void Absent(System.Xml.Linq.XElement owner,string name) {
            Need(!owner.Elements().Any(e=>Name(e)==name),"Original JSON unsupported member present: "+name);
        }
        static void Unique(System.Xml.Linq.XElement value) {
            if(Kind(value)=="object") {
                var names=new HashSet<string>(StringComparer.Ordinal);
                foreach(var child in value.Elements()) Need(names.Add(Name(child)),"Original JSON duplicate decoded object member");
            }
            foreach(var child in value.Elements()) Unique(child);
        }
        public static void Validate(string json) {
            Need(!String.IsNullOrEmpty(json),"Original JSON source is present");
            new JsonBoundary(json).Validate();
            var bytes=new System.Text.UTF8Encoding(false,true).GetBytes(json);
            var quotas=new System.Xml.XmlDictionaryReaderQuotas {MaxDepth=128,MaxStringContentLength=json.Length,MaxArrayLength=json.Length,MaxNameTableCharCount=json.Length,MaxBytesPerRead=4096};
            System.Xml.Linq.XElement root;
            using(var reader=System.Runtime.Serialization.Json.JsonReaderWriterFactory.CreateJsonReader(bytes,quotas)) {
                root=System.Xml.Linq.XElement.Load(reader);
                while(reader.Read()) Need(reader.NodeType==System.Xml.XmlNodeType.Whitespace,"Original JSON complete single root");
            }
            Need(Kind(root)=="object","Original JSON root object");Unique(root);
            Number(root,"scene");
            foreach(var a in Objects(root,"accessors")) {
                Absent(a,"sparse");Number(a,"bufferView");Number(a,"componentType");Number(a,"count");Number(a,"byteOffset",false);
                Member(a,"type","string");Member(a,"normalized","boolean",false);Numbers(a,"min");Numbers(a,"max");
            }
            foreach(var v in Objects(root,"bufferViews")) {Number(v,"buffer");Number(v,"byteLength");Number(v,"byteOffset",false);Number(v,"byteStride",false);}
            foreach(var b in Objects(root,"buffers")) {Number(b,"byteLength");Member(b,"uri","string",false);}
            foreach(var node in Objects(root,"nodes")) {
                Member(node,"name","string");Number(node,"mesh",false);Absent(node,"skin");Absent(node,"matrix");
                Numbers(node,"translation");Numbers(node,"rotation");Numbers(node,"scale");Numbers(node,"children",false,true);
            }
            foreach(var scene in Objects(root,"scenes")) Numbers(scene,"nodes",true,true);
            foreach(var mesh in Objects(root,"meshes")) foreach(var primitive in Objects(mesh,"primitives")) {
                var attributes=Member(primitive,"attributes","object");
                foreach(string name in new[]{"POSITION","NORMAL","TEXCOORD_0","COLOR_0"}) Number(attributes,name);
                Number(primitive,"indices");Number(primitive,"material");Number(primitive,"mode",false);Absent(primitive,"targets");
            }
            foreach(var material in Objects(root,"materials")) {
                Member(material,"name","string");Member(material,"doubleSided","boolean");Member(material,"alphaMode","string",false);
                var extensions=Member(material,"extensions","object");var unlit=Member(extensions,"KHR_materials_unlit","object");
                Need(!unlit.HasElements,"Original JSON unlit extension is its actual empty object");
                var pbr=Member(material,"pbrMetallicRoughness","object");var texture=Member(pbr,"baseColorTexture","object");
                Number(texture,"index");Number(texture,"texCoord",false);Numbers(pbr,"baseColorFactor");
                Number(pbr,"metallicFactor",false,false);Number(pbr,"roughnessFactor",false,false);
            }
            foreach(var texture in Objects(root,"textures")) {Number(texture,"source");Number(texture,"sampler");}
            foreach(var sampler in Objects(root,"samplers")) foreach(string name in new[]{"magFilter","minFilter","wrapS","wrapT"}) Number(sampler,name);
            foreach(var image in Objects(root,"images")) {Number(image,"bufferView");Member(image,"mimeType","string");Member(image,"uri","string",false);}
            foreach(string name in new[]{"animations","skins"}) {var value=Member(root,name,"array",false);Need(value==null || !value.HasElements,"Original JSON static profile excludes animated/deformed inventories");}
        }
    }
`;

// Independent reader of the original GLB's indexed attributes and hierarchy.
const sourceAudit = (n: NativeAppNames): string => String.raw`
${UNITY_PRECISION_JSON_PRESENCE}
    [Serializable] class SRoot { public SNode[] nodes; public SMesh[] meshes; public SAccessor[] accessors; public SView[] bufferViews; public SBuffer[] buffers; public SScene[] scenes; public int scene; public SNamed[] animations,skins; public SMaterial[] materials; public STexture[] textures; public SSampler[] samplers; public SImage[] images; }
    [Serializable] class SNamed { public string name; }
    [Serializable] class SNode { public SNode() {} public string name; public int mesh=-1,skin=-1; public int[] children; public double[] translation,rotation,scale,matrix; }
    [Serializable] class SMesh { public SPrimitive[] primitives; }
    [Serializable] class SPrimitive { public SPrimitive() {} public SAttributes attributes; public int indices=-1,material=-1,mode=4; public SNamed[] targets; }
    [Serializable] class SAttributes { public SAttributes() {} public int POSITION=-1,NORMAL=-1,TEXCOORD_0=-1,COLOR_0=-1; }
    [Serializable] class SAccessor { public int bufferView,byteOffset,count,componentType; public string type; public bool normalized; }
    [Serializable] class SView { public int buffer,byteOffset,byteLength,byteStride; }
    [Serializable] class SBuffer { public int byteLength; public string uri; }
    [Serializable] class SScene { public string name; public int[] nodes; }
    [Serializable] class SMaterial { public string name,alphaMode; public bool doubleSided; public SPbr pbrMetallicRoughness; }
    [Serializable] class SPbr { public float[] baseColorFactor; public STextureInfo baseColorTexture; }
    [Serializable] class STextureInfo { public int index,texCoord; }
    [Serializable] class STexture { public STexture() {} public int source=-1,sampler=-1; }
    [Serializable] class SSampler { public int magFilter,minFilter,wrapS,wrapT; }
    [Serializable] class SImage { public SImage() {} public int bufferView=-1; public string mimeType,uri; }
    class SourceData { public SRoot g; public byte[] bytes; public int binStart,binLength; public int[] roots,parents; public string nativeStem; public bool originalJsonSchemaVerified; }
    class StreamReader {
        readonly SourceData source; readonly SAccessor accessor; readonly SView view; readonly int width,size,stride; public int Count=>accessor.count; public int Component=>accessor.componentType;
        public StreamReader(SourceData source,int index,int width) {
            this.source=source;this.width=width;Need(index>=0 && index<source.g.accessors.Length,"Source accessor identity");accessor=source.g.accessors[index];
            Need(accessor.bufferView>=0 && accessor.bufferView<source.g.bufferViews.Length,"Source buffer view identity");view=source.g.bufferViews[accessor.bufferView];
            string expected=width==1?"SCALAR":"VEC"+width;size=accessor.componentType==5121?1:accessor.componentType==5123?2:accessor.componentType==5125||accessor.componentType==5126?4:0;stride=view.byteStride==0?width*size:view.byteStride;
            Need(source.originalJsonSchemaVerified && size>0 && accessor.type==expected && !accessor.normalized && accessor.count>0 && accessor.byteOffset>=0 && view.buffer==0 && view.byteOffset>=0 && view.byteLength>0 && stride>=width*size && (long)view.byteOffset+view.byteLength<=source.g.buffers[0].byteLength && (long)accessor.byteOffset+(long)(accessor.count-1)*stride+width*size<=view.byteLength,"Complete bounded source accessor: index="+index+" width="+width+" expectedType="+expected+" componentSize="+size+" stride="+stride+" originalJsonSchemaVerified="+source.originalJsonSchemaVerified+" accessor="+JsonUtility.ToJson(accessor)+" view="+JsonUtility.ToJson(view)+" buffer="+JsonUtility.ToJson(source.g.buffers[0]));
        }
        public double Get(int index,int axis=0) { Need(index>=0 && index<Count && axis>=0 && axis<width,"Source physical index");int at=checked(source.binStart+view.byteOffset+accessor.byteOffset+index*stride+axis*size);double value=Component==5126?BitConverter.ToSingle(source.bytes,at):Component==5125?BitConverter.ToUInt32(source.bytes,at):Component==5123?BitConverter.ToUInt16(source.bytes,at):source.bytes[at];Need(!Double.IsNaN(value)&&!Double.IsInfinity(value),"Finite source attribute");return value; }
    }
    static bool SafeNativeStem(string value) => !String.IsNullOrWhiteSpace(value) && value==value.TrimEnd(' ','.') && value!="." && value!=".." && value.IndexOfAny(Path.GetInvalidFileNameChars())<0 && !System.Text.RegularExpressions.Regex.IsMatch(value,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    static SourceData ReadOriginalGlb(byte[] bytes,Manifest manifest,byte[] rgba) {
        Need(JsonUtility.FromJson<SNode>("{\"name\":\"absent-field-probe\"}").mesh==-1 && JsonUtility.FromJson<SNode>("{}").skin==-1 && JsonUtility.FromJson<SPrimitive>("{}").indices==-1 && JsonUtility.FromJson<SAttributes>("{}").NORMAL==-1,"Native JSON absent-field defaults");
        Need(bytes.Length>=28 && BitConverter.ToUInt32(bytes,0)==0x46546c67 && BitConverter.ToUInt32(bytes,4)==2 && BitConverter.ToUInt32(bytes,8)==bytes.Length && BitConverter.ToUInt32(bytes,16)==0x4e4f534a,"Original GLB container");
        int jsonLength=checked((int)BitConverter.ToUInt32(bytes,12)),binStart=checked(28+jsonLength);Need(jsonLength>0 && binStart<=bytes.Length && BitConverter.ToUInt32(bytes,24+jsonLength)==0x004e4942,"Original complete GLB chunks");int binLength=checked((int)BitConverter.ToUInt32(bytes,20+jsonLength));Need((long)binStart+binLength==bytes.Length,"Original GLB complete BIN");
        string sourceJSON=new System.Text.UTF8Encoding(false,true).GetString(bytes,20,jsonLength);OriginalJsonPresence.Validate(sourceJSON);
        var g=JsonUtility.FromJson<SRoot>(sourceJSON);Need(g!=null && g.nodes!=null && g.nodes.Length==manifest.objects && g.meshes!=null && g.accessors!=null && g.bufferViews!=null && g.buffers?.Length==1 && g.buffers[0].byteLength>0 && g.buffers[0].byteLength<=binLength && String.IsNullOrEmpty(g.buffers[0].uri) && g.scenes!=null && g.scene>=0 && g.scene<g.scenes.Length,"Original GLB inventories");
        Need((g.skins?.Length??0)==0 && (g.animations?.Length??0)==0 && g.nodes.All(n=>n.skin==-1 && (n.matrix?.Length??0)==0 && !String.IsNullOrWhiteSpace(n.name)) && g.nodes.Select(n=>n.name).Distinct().Count()==g.nodes.Length,"Static original source with unambiguous authored identities");
        var roots=g.scenes[g.scene].nodes;Need(roots!=null && roots.Length>0 && roots.Distinct().Count()==roots.Length && roots.All(i=>i>=0 && i<g.nodes.Length),"Original active scene roots");var parents=Enumerable.Repeat(-1,g.nodes.Length).ToArray();
        for(int i=0;i<g.nodes.Length;i++) foreach(int child in g.nodes[i].children??Array.Empty<int>()) {Need(child>=0 && child<g.nodes.Length && parents[child]==-1 && !roots.Contains(child),"Original single-parent hierarchy");parents[child]=i;}
        Need(Enumerable.Range(0,g.nodes.Length).All(i=>(parents[i]<0)==roots.Contains(i)),"Complete original root inventory");var reached=new HashSet<int>();Action<int> visit=null;visit=i=>{Need(reached.Add(i),"Original acyclic active hierarchy");foreach(int child in g.nodes[i].children??Array.Empty<int>())visit(child);};foreach(int i in roots)visit(i);Need(reached.Count==g.nodes.Length,"Every original node active");
        string stem=roots.Length==1?g.nodes[roots[0]].name:"${n.name}Scene";Need(SafeNativeStem(stem),"Authored root needs a supported native filename; source names are never sanitized silently");
        Need(g.materials?.Length==1 && g.textures?.Length==1 && g.images?.Length==1 && g.samplers?.Length==1,"Original single material/image profile");var material=g.materials[0];Need((String.IsNullOrEmpty(material.alphaMode)||material.alphaMode=="OPAQUE") && material.doubleSided && material.pbrMetallicRoughness?.baseColorTexture!=null && material.pbrMetallicRoughness.baseColorTexture.index==0 && material.pbrMetallicRoughness.baseColorTexture.texCoord==0 && (material.pbrMetallicRoughness.baseColorFactor??new float[]{1,1,1,1}).SequenceEqual(new float[]{1,1,1,1}),"Original explicit opaque double-sided white unlit material");
        Need(g.textures[0].source==0 && g.textures[0].sampler==0 && g.samplers[0].magFilter==9728 && g.samplers[0].minFilter==9728 && g.samplers[0].wrapS==33071 && g.samplers[0].wrapT==33071,"Original exact nearest/clamp texture association");
        var image=g.images[0];Need(image.mimeType=="image/png" && String.IsNullOrEmpty(image.uri) && image.bufferView>=0 && image.bufferView<g.bufferViews.Length,"Original embedded PNG");var v=g.bufferViews[image.bufferView];Need(v.buffer==0 && v.byteOffset>=0 && v.byteLength>0 && (long)v.byteOffset+v.byteLength<=g.buffers[0].byteLength,"Original PNG bounds");var png=new byte[v.byteLength];Buffer.BlockCopy(bytes,binStart+v.byteOffset,png,0,png.Length);var originalPixels=OriginalPngPixels(png,out int width,out int height);Need(width==manifest.image.width && height==manifest.image.height && originalPixels.SequenceEqual(rgba),"Every original GLB PNG pixel equals complete source RGBA");
        return new SourceData{g=g,bytes=bytes,binStart=binStart,binLength=binLength,roots=roots,parents=parents,nativeStem=stem,originalJsonSchemaVerified=true};
    }
    static int Be32(byte[] bytes,int at) => checked((int)(((uint)bytes[at]<<24)|((uint)bytes[at+1]<<16)|((uint)bytes[at+2]<<8)|bytes[at+3]));
    static byte[] OriginalPngPixels(byte[] png,out int width,out int height) {
        Need(png.Length>=33 && png.Take(8).SequenceEqual(new byte[]{137,80,78,71,13,10,26,10}),"Original PNG signature");width=0;height=0;int channels=0;bool complete=false;var idat=new MemoryStream();
        for(int at=8;at<png.Length;) {Need(at+12L<=png.Length,"Original PNG chunk header");int length=Be32(png,at);Need(at+12L+length<=png.Length,"Original PNG chunk bounds");string kind=System.Text.Encoding.ASCII.GetString(png,at+4,4);if(kind=="IHDR"){Need(at==8 && length==13,"Original PNG IHDR");width=Be32(png,at+8);height=Be32(png,at+12);Need(png[at+16]==8 && (png[at+17]==6||png[at+17]==2) && png[at+18]==0 && png[at+19]==0 && png[at+20]==0,"Original PNG8 RGB/RGBA profile");channels=png[at+17]==6?4:3;}if(kind=="IDAT")idat.Write(png,at+8,length);at=checked(at+length+12);if(kind=="IEND"){Need(length==0 && at==png.Length,"Original complete PNG end");complete=true;break;}}
        Need(complete && width>0 && height>0 && channels>0,"Original complete PNG inventory");var compressed=idat.ToArray();Need(compressed.Length>6 && (compressed[0]&15)==8 && (compressed[1]&32)==0 && ((compressed[0]<<8)+compressed[1])%31==0,"Original PNG zlib header");byte[] raw;using(var input=new MemoryStream(compressed,2,compressed.Length-6))using(var deflate=new System.IO.Compression.DeflateStream(input,System.IO.Compression.CompressionMode.Decompress))using(var output=new MemoryStream()){deflate.CopyTo(output);raw=output.ToArray();}
        int stride=checked(width*channels);Need(raw.Length==checked((stride+1)*height),"Original PNG full scanline length");var pixels=new byte[checked(width*height*4)];var previous=new byte[stride];
        for(int y=0;y<height;y++){int start=y*(stride+1),mode=raw[start];Need(mode<=4,"Original PNG filter");var row=new byte[stride];Buffer.BlockCopy(raw,start+1,row,0,stride);for(int x=0;x<stride;x++){int left=x>=channels?row[x-channels]:0,up=previous[x],upper=x>=channels?previous[x-channels]:0,predictor=0;if(mode==1)predictor=left;else if(mode==2)predictor=up;else if(mode==3)predictor=(left+up)/2;else if(mode==4){int p=left+up-upper,a=Math.Abs(p-left),b=Math.Abs(p-up),c=Math.Abs(p-upper);predictor=a<=b&&a<=c?left:b<=c?up:upper;}row[x]=(byte)((row[x]+predictor)&255);}for(int x=0;x<width;x++){int target=(y*width+x)*4;pixels[target]=row[x*channels];pixels[target+1]=row[x*channels+1];pixels[target+2]=row[x*channels+2];pixels[target+3]=channels==4?row[x*channels+3]:(byte)255;}previous=row;}
        return pixels;
    }
    static Vector3 ReflectX(Vector3 v)=>new Vector3(-v.x,v.y,v.z);
    static double Error(Vector3 a,Vector3 b)=>Math.Max(Math.Abs(a.x-b.x),Math.Max(Math.Abs(a.y-b.y),Math.Abs(a.z-b.z)));
    static double Error(Vector3 a,double[] b)=>Math.Max(Math.Abs(a.x-b[0]),Math.Max(Math.Abs(a.y-b[1]),Math.Abs(a.z-b[2])));
    static double Error(Vector2 a,Vector2 b)=>Math.Max(Math.Abs(a.x-b.x),Math.Abs(a.y-b.y));
    static double Error(Color a,Color b)=>Math.Max(Math.Max(Math.Abs(a.r-b.r),Math.Abs(a.g-b.g)),Math.Max(Math.Abs(a.b-b.b),Math.Abs(a.a-b.a)));
    static double RotationError(Quaternion a,Quaternion b)=>Math.Min(Math.Max(Math.Max(Math.Abs(a.x-b.x),Math.Abs(a.y-b.y)),Math.Max(Math.Abs(a.z-b.z),Math.Abs(a.w-b.w))),Math.Max(Math.Max(Math.Abs(a.x+b.x),Math.Abs(a.y+b.y)),Math.Max(Math.Abs(a.z+b.z),Math.Abs(a.w+b.w))));
    static double RotationError(Quaternion a,double[] b)=>Math.Min(Math.Max(Math.Max(Math.Abs(a.x-b[0]),Math.Abs(a.y-b[1])),Math.Max(Math.Abs(a.z-b[2]),Math.Abs(a.w-b[3]))),Math.Max(Math.Max(Math.Abs(a.x+b[0]),Math.Abs(a.y+b[1])),Math.Max(Math.Abs(a.z+b[2]),Math.Abs(a.w+b[3]))));
    static readonly double[] IdentityD={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    static double[] MultiplyD(double[] a,double[] b){var result=new double[16];for(int column=0;column<4;column++)for(int row=0;row<4;row++)for(int k=0;k<4;k++)result[column*4+row]+=a[k*4+row]*b[column*4+k];return result;}
    static double[] PointD(double[] m,Vector3 p)=>new double[]{m[0]*p.x+m[4]*p.y+m[8]*p.z+m[12],m[1]*p.x+m[5]*p.y+m[9]*p.z+m[13],m[2]*p.x+m[6]*p.y+m[10]*p.z+m[14]};
    static double[] LocalD(double[] p,double[] q,double[] s){double x=q[0],y=q[1],z=q[2],w=q[3];return new double[]{(1-2*(y*y+z*z))*s[0],2*(x*y+z*w)*s[0],2*(x*z-y*w)*s[0],0,2*(x*y-z*w)*s[1],(1-2*(x*x+z*z))*s[1],2*(y*z+x*w)*s[1],0,2*(x*z+y*w)*s[2],2*(y*z-x*w)*s[2],(1-2*(x*x+y*y))*s[2],0,p[0],p[1],p[2],1};}
    class SourceCorner {public Vector3 p,n;public Vector2 uv;public Color c;}
    class SourceTriangle {public SourceCorner[] corners;public bool used;}
    static string Cell(Vector3 p,int x=0,int y=0,int z=0)=>((long)Math.Floor(p.x/.001)+x)+"/"+((long)Math.Floor(p.y/.001)+y)+"/"+((long)Math.Floor(p.z/.001)+z);
    static Vector3 Center(SourceCorner[] c)=>(c[0].p+c[1].p+c[2].p)/3f;
    static void VerifyOriginalMesh(SourceData source,SNode original,Transform node,double[] world,Result result,ref int triangles,ref int meshes) {
        var filter=node.GetComponent<MeshFilter>();if(original.mesh<0){Need(filter==null && node.GetComponent<Renderer>()==null,"Empty original logical node remains empty");return;}
        Need(original.mesh<source.g.meshes.Length && source.g.meshes[original.mesh].primitives?.Length==1,"One original material primitive per mesh");var primitive=source.g.meshes[original.mesh].primitives[0];Need(primitive.mode==4 && primitive.material==0 && (primitive.targets?.Length??0)==0 && primitive.attributes!=null,"Original static triangle material association");
        var a=primitive.attributes;var p=new StreamReader(source,a.POSITION,3);var n=new StreamReader(source,a.NORMAL,3);var uv=new StreamReader(source,a.TEXCOORD_0,2);var c=new StreamReader(source,a.COLOR_0,4);var ix=new StreamReader(source,primitive.indices,1);Need(p.Component==5126 && n.Component==5126 && uv.Component==5126 && c.Component==5126 && n.Count==p.Count && uv.Count==p.Count && c.Count==p.Count && (ix.Component==5121||ix.Component==5123||ix.Component==5125) && ix.Count%3==0,"Complete original indexed Float32 attributes");
        var expected=new List<SourceTriangle>();var buckets=new Dictionary<string,List<SourceTriangle>>();int[] order={0,2,1};
        for(int i=0;i<ix.Count;i+=3){var corners=new SourceCorner[3];for(int k=0;k<3;k++){int at=checked((int)ix.Get(i+order[k]));Need(at<p.Count,"Original complete physical index");corners[k]=new SourceCorner{p=ReflectX(new Vector3((float)p.Get(at,0),(float)p.Get(at,1),(float)p.Get(at,2))),n=ReflectX(new Vector3((float)n.Get(at,0),(float)n.Get(at,1),(float)n.Get(at,2))),uv=new Vector2((float)uv.Get(at,0),1-(float)uv.Get(at,1)),c=new Color((float)c.Get(at,0),(float)c.Get(at,1),(float)c.Get(at,2),(float)c.Get(at,3))};}var triangle=new SourceTriangle{corners=corners};expected.Add(triangle);string key=Cell(Center(corners));if(!buckets.ContainsKey(key))buckets[key]=new List<SourceTriangle>();buckets[key].Add(triangle);}
        Need(filter!=null && filter.sharedMesh!=null && filter.sharedMesh.isReadable,"Original node owns a readable native mesh");var mesh=filter.sharedMesh;var renderer=node.GetComponent<MeshRenderer>();Need(MeshUtility.GetMeshCompression(mesh)==ModelImporterMeshCompression.Off && mesh.subMeshCount==1 && mesh.GetTopology(0)==MeshTopology.Triangles && renderer!=null && renderer.sharedMaterials.Length==1 && renderer.sharedMaterials[0]!=null && renderer.sharedMaterials[0].name==source.g.materials[0].name,"Native full precision mesh and original material identity");
        var positions=mesh.vertices;var normals=mesh.normals;var tex=mesh.uv;var colors=mesh.colors;var indices=mesh.GetTriangles(0);Need(positions.Length==p.Count && normals.Length==positions.Length && tex.Length==positions.Length && colors.Length==positions.Length && indices.Length==ix.Count,"Every original physical native attribute/index");var used=new bool[positions.Length];int matched=0;
        for(int i=0;i<indices.Length;i+=3){var actual=new SourceCorner[3];for(int k=0;k<3;k++){int at=indices[i+k];Need(at>=0 && at<positions.Length,"Complete native physical index");used[at]=true;actual[k]=new SourceCorner{p=positions[at],n=normals[at],uv=tex[at],c=colors[at]};}SourceTriangle match=null;int shift=0;var center=Center(actual);
            for(int x=-1;x<=1&&match==null;x++)for(int y=-1;y<=1&&match==null;y++)for(int z=-1;z<=1&&match==null;z++){if(!buckets.TryGetValue(Cell(center,x,y,z),out var candidates))continue;foreach(var candidate in candidates){if(candidate.used)continue;for(int s=0;s<3;s++){bool equal=true;for(int k=0;k<3;k++){var wanted=candidate.corners[(k+s)%3];equal&=Error(actual[k].p,wanted.p)<=0.00001 && Error(actual[k].n,wanted.n)<=0.00001 && Error(actual[k].uv,wanted.uv)<=0.000001 && Error(actual[k].c,wanted.c)<=0.000001;}if(equal){match=candidate;shift=s;break;}}if(match!=null)break;}}
            Need(match!=null,"Every original oriented triangle/corner association exactly once: "+original.name);match.used=true;matched++;for(int k=0;k<3;k++){var wanted=match.corners[(k+shift)%3];result.maxLocalPositionError=Math.Max(result.maxLocalPositionError,Error(actual[k].p,wanted.p));result.maxNormalError=Math.Max(result.maxNormalError,Error(actual[k].n,wanted.n));result.maxUvError=Math.Max(result.maxUvError,Error(actual[k].uv,wanted.uv));result.maxColorError=Math.Max(result.maxColorError,Error(actual[k].c,wanted.c));result.maxWorldPositionError=Math.Max(result.maxWorldPositionError,Error(node.TransformPoint(actual[k].p),PointD(world,wanted.p)));}}
        Need(matched==expected.Count && expected.All(t=>t.used) && used.All(v=>v),"Every original and native reference used exactly once");triangles+=matched;meshes++;
    }
    static void VerifyOriginalGlb(GameObject root,SourceData source,Manifest manifest,Result result) {
        Need(root.name==source.nativeStem,"Native prefab retains exact authored root identity");var materials=root.GetComponentsInChildren<Renderer>(true).SelectMany(r=>r.sharedMaterials).Distinct().ToArray();Need(materials.Length==1 && materials[0]!=null && materials[0].name==source.g.materials[0].name,"Exact original bound material identity");var material=materials[0];Need(material.shader!=null && material.shader.name=="glTF/Unlit" && material.shader.isSupported && !ShaderUtil.ShaderHasError(material.shader),"Original native supported unlit shader");Need(material.HasProperty("baseColorFactor") && Error(material.GetColor("baseColorFactor"),Color.white)==0 && material.HasProperty("_CullMode") && material.GetFloat("_CullMode")==0 && material.HasProperty("_Mode") && material.GetFloat("_Mode")==0 && material.HasProperty("_SrcBlend") && material.GetFloat("_SrcBlend")==1 && material.HasProperty("_DstBlend") && material.GetFloat("_DstBlend")==0 && material.HasProperty("_ZWrite") && material.GetFloat("_ZWrite")==1 && !material.IsKeywordEnabled("_ALPHATEST_ON") && !material.IsKeywordEnabled("_ALPHABLEND_ON") && !material.IsKeywordEnabled("_ALPHAPREMULTIPLY_ON"),"Original double-sided opaque white material settings");int objects=0,triangles=0,meshes=0;Action<int,Transform,double[]> visit=null;
        visit=(index,node,parentWorld)=>{var original=source.g.nodes[index];Need(node.name==original.name,"Exact original logical node identity: "+original.name);Need((original.translation==null||original.translation.Length==3)&&(original.rotation==null||original.rotation.Length==4)&&(original.scale==null||original.scale.Length==3),"Original TRS shape");var t=original.translation??new double[]{0,0,0};var r=original.rotation??new double[]{0,0,0,1};var p=new double[]{-t[0],t[1],t[2]};var q=new double[]{r[0],-r[1],-r[2],r[3]};var s=original.scale??new double[]{1,1,1};Need(p.Concat(q).Concat(s).All(v=>!Double.IsNaN(v)&&!Double.IsInfinity(v)),"Finite original double TRS");Need(Error(node.localPosition,p)<=0.00001 && RotationError(node.localRotation,q)<=0.00001 && Error(node.localScale,s)<=0.00001,"Original authored double local TRS: "+original.name);var world=MultiplyD(parentWorld,LocalD(p,q,s));var children=original.children??Array.Empty<int>();Need(node.childCount==children.Length,"No missing/extra native logical nodes: "+original.name);objects++;VerifyOriginalMesh(source,original,node,world,result,ref triangles,ref meshes);foreach(int child in children){var found=Enumerable.Range(0,node.childCount).Select(i=>node.GetChild(i)).Where(n=>n.name==source.g.nodes[child].name).ToArray();Need(found.Length==1,"Original parent-qualified child identity");visit(child,found[0],world);}};
        if(source.roots.Length==1)visit(source.roots[0],root.transform,IdentityD);else{Need(root.transform.childCount==source.roots.Length && root.GetComponent<MeshFilter>()==null && root.GetComponent<Renderer>()==null && Error(root.transform.localPosition,Vector3.zero)==0 && RotationError(root.transform.localRotation,Quaternion.identity)==0 && Error(root.transform.localScale,Vector3.one)==0,"Explicit identity synthetic scene container only");foreach(int index in source.roots){var found=Enumerable.Range(0,root.transform.childCount).Select(i=>root.transform.GetChild(i)).Where(n=>n.name==source.g.nodes[index].name).ToArray();Need(found.Length==1,"Original active root identity beneath native scene container");visit(index,found[0],IdentityD);}}
        Need(objects==source.g.nodes.Length && objects==manifest.objects && triangles==manifest.triangles && meshes==source.g.meshes.Length && result.maxWorldPositionError<=0.00001,"Complete native source identity, indexed geometry and world-position bounds");result.authoredIdentityPreserved=true;result.sourceObjects=objects;result.sourceTriangles=triangles;
    }
`;

/**
 * The Unity Editor helper, `Editor/<appName>PrecisionImporter.cs` in the bundle. It imports the bundle's GLB with the
 * unmodified glTFast importer into a new owned folder, binds the original atlas (readable, uncompressed RGBA32,
 * point, clamp) to a clone of the unlit material, saves a prefab and checks every source triangle, corner, node and
 * texel before adaptation and after save and reopen. Run `<appName>Precision.BundleImporter.RunFromEnvironment`
 * with `<APPNAME>_UNITY_BUNDLE` and `<APPNAME>_UNITY_REPORT` set, or use the `<appName>` menu.
 * @throws TypeError for an invalid `appName` or `extension`.
 */
export function createUnityPrecisionImporter(options: UnityPrecisionImporterOptions): string {
  const n = nativeAppNames(options?.appName);
  const o = { extension: nativeExtension(options.extension, 'extension') };
  return String.raw`// ${n.name} bounded static precision integration; install beneath Assets/Editor.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace ${n.name}Precision {
public static class BundleImporter {
    [Serializable] public class FileInfo { public string filename, sha256; }
    [Serializable] public class Master : FileInfo { public string role; }
    [Serializable] public class ImageInfo : FileInfo { public int width, height; public string origin; }
    [Serializable] public class Manifest {
        public int version, triangles, objects;
        public string profileId, sourceSnapshotSha256, sourceSnapshotOptionsJSON, importerSha256;
        public FileInfo glb; public Master sourceMaster; public ImageInfo image;
    }
    [Serializable] public class Result {
        public int version=1, processId, triangles, meshes, objects, sourceObjects, sourceTriangles;
        public string status="running", unityVersion, importerVersion, sourceManifestSha256, sourceGlbSha256, sourceMasterSha256, prefabPath, outputDirectory, sourceImportPath, rootIdentity, geometryBeforeSha256, geometryAfterSha256, rgbaSha256, exception;
        public bool geometryAndHierarchyUnchanged, authoredIdentityPreserved, originalGlbMatchedBeforeAdaptation, originalGlbMatchedAfterReopen, fullRgbaExact, pointClampExact, nativeSaveReopenVerified;
        public double maxLocalPositionError, maxWorldPositionError, maxNormalError, maxUvError, maxColorError;
        public string scope="Bounded opaque double-sided glTF/Unlit static profile. Exact imported geometry/hierarchy and full original RGBA sampler restoration. Shader render/device and fresh-process gates are separate.";
    }
    static string Hash(byte[] bytes) { using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static void Need(bool ok,string message) { if(!ok) throw new InvalidDataException("${n.upper}_UNITY_PRECISION: "+message); }
    // Only OS file I/O receives an extended Windows path. Every AssetDatabase
    // identifier, authored name and reported logical Assets/ path stays exact.
    static string NativeFilePath(string path) {
        if(Path.DirectorySeparatorChar!='\\')return Path.GetFullPath(path);
        if(path.StartsWith(@"\\?\",StringComparison.Ordinal))return path;
        var full=Path.GetFullPath(path);
        return full.StartsWith(@"\\",StringComparison.Ordinal)?@"\\?\UNC\"+full.Substring(2):@"\\?\"+full;
    }
    static byte[] ReadFileBytes(string path) => File.ReadAllBytes(NativeFilePath(path));
    static void WriteFileBytes(string path,byte[] bytes) => File.WriteAllBytes(NativeFilePath(path),bytes);
    static string Member(string folder,string name) { Need(!String.IsNullOrEmpty(name) && name==Path.GetFileName(name) && !name.Contains("\\") && !name.Contains(":") && name!="." && name!="..","Unsafe bundle member"); return Path.Combine(folder,name); }
    static byte[] Read(string folder,FileInfo info) { var bytes=ReadFileBytes(Member(folder,info.filename)); Need(Hash(bytes)==info.sha256,"Source member SHA-256 "+info.filename); return bytes; }
    static byte[] FlipRows(byte[] source,int width,int height) { int stride=checked(width*4); Need(source.Length==checked(stride*height),"Full original RGBA byte count"); var result=new byte[source.Length]; for(int y=0;y<height;y++) Buffer.BlockCopy(source,y*stride,result,(height-1-y)*stride,stride); return result; }
    static byte[] Pixels(Texture2D texture) { var values=texture.GetPixels32(0); var result=new byte[values.Length*4]; for(int i=0;i<values.Length;i++) { result[i*4]=values[i].r; result[i*4+1]=values[i].g; result[i*4+2]=values[i].b; result[i*4+3]=values[i].a; } return result; }
${sourceAudit(n)}
    static void Write(BinaryWriter writer,Vector3 value) { writer.Write(value.x);writer.Write(value.y);writer.Write(value.z); }
    static string GeometryHash(GameObject root,out int triangles,out int meshes,out int objects) {
        triangles=0; meshes=0; objects=0;
        using(var stream=new MemoryStream()) using(var writer=new BinaryWriter(stream)) {
            Visit(root.transform,writer,ref triangles,ref meshes,ref objects);
            writer.Flush(); return Hash(stream.ToArray());
        }
    }
    static void Visit(Transform node,BinaryWriter writer,ref int triangles,ref int meshes,ref int objects) {
        objects++; writer.Write(node.name); Write(writer,node.localPosition); var q=node.localRotation; writer.Write(q.x);writer.Write(q.y);writer.Write(q.z);writer.Write(q.w); Write(writer,node.localScale);
        var filter=node.GetComponent<MeshFilter>(); writer.Write(filter!=null);
        if(filter!=null) {
            var mesh=filter.sharedMesh; Need(mesh!=null && mesh.isReadable,"Complete readable official imported mesh"); Need(MeshUtility.GetMeshCompression(mesh)==ModelImporterMeshCompression.Off,"Native mesh compression must remain off"); meshes++;
            var p=mesh.vertices;var n=mesh.normals;var uv=mesh.uv;var c=mesh.colors;
            Need(p.Length>0 && n.Length==p.Length && uv.Length==p.Length && c.Length==p.Length,"Complete native position/normal/UV/RGBA");
            writer.Write(p.Length); for(int i=0;i<p.Length;i++) { Write(writer,p[i]);Write(writer,n[i]);writer.Write(uv[i].x);writer.Write(uv[i].y);writer.Write(c[i].r);writer.Write(c[i].g);writer.Write(c[i].b);writer.Write(c[i].a); }
            writer.Write(mesh.subMeshCount); for(int surface=0;surface<mesh.subMeshCount;surface++) { Need(mesh.GetTopology(surface)==MeshTopology.Triangles,"Native triangle topology"); var ix=mesh.GetTriangles(surface);Need(ix.Length%3==0,"Native complete index triples"); writer.Write(ix.Length);foreach(int index in ix) writer.Write(index);triangles+=ix.Length/3; }
        }
        writer.Write(node.childCount);for(int index=0;index<node.childCount;index++) Visit(node.GetChild(index),writer,ref triangles,ref meshes,ref objects);
    }
    static void AuditTexture(GameObject root,Manifest manifest,string expectedAssetPath,Result result) {
        var materials=root.GetComponentsInChildren<Renderer>(true).SelectMany(r=>r.sharedMaterials).Distinct().ToArray(); Need(materials.Length==1 && materials[0]!=null,"One native bound material");
        var material=materials[0]; Need(material.shader!=null && material.shader.name=="glTF/Unlit" && material.shader.isSupported && !ShaderUtil.ShaderHasError(material.shader),"Supported exact native glTF/Unlit shader");
        var texture=material.mainTexture as Texture2D; Need(texture!=null && AssetDatabase.GetAssetPath(texture)==expectedAssetPath,"Material binds the new owned texture asset");
        Need(texture.width==manifest.image.width && texture.height==manifest.image.height && texture.format==TextureFormat.RGBA32 && texture.isReadable && texture.mipmapCount==1,"Full readable uncompressed RGBA32 dimensions without generated mip levels");
        result.rgbaSha256=Hash(FlipRows(Pixels(texture),texture.width,texture.height)); result.fullRgbaExact=result.rgbaSha256==manifest.image.sha256; Need(result.fullRgbaExact,"Every original RGBA pixel after native resource reopen");
        result.pointClampExact=texture.filterMode==FilterMode.Point && texture.wrapModeU==TextureWrapMode.Clamp && texture.wrapModeV==TextureWrapMode.Clamp; Need(result.pointClampExact,"Actual native Point/Clamp sampler");
    }
    public static Result ImportBundle(string manifestPath) {
        var result=new Result{processId=System.Diagnostics.Process.GetCurrentProcess().Id,unityVersion=Application.unityVersion}; GameObject instance=null, reopened=null;
        try {
            manifestPath=Path.GetFullPath(manifestPath); var folder=Path.GetDirectoryName(manifestPath); var manifestBytes=ReadFileBytes(manifestPath); result.sourceManifestSha256=Hash(manifestBytes);
            var manifest=JsonUtility.FromJson<Manifest>(System.Text.Encoding.UTF8.GetString(manifestBytes)); Need(manifest!=null && manifest.version==1 && manifest.profileId=="unity-gltfast-static-point-clamp-v1" && manifest.image.origin=="top-left", "Supported explicit static precision manifest");
            var integration=AssetDatabase.FindAssets("${n.name}PrecisionImporter t:MonoScript").Select(AssetDatabase.GUIDToAssetPath).Where(p=>Path.GetFileName(p)=="${n.name}PrecisionImporter.cs").ToArray();Need(integration.Length==1 && Hash(ReadFileBytes(integration[0]))==manifest.importerSha256,"Exact exported app-owned integration source");
            var glb=Read(folder,manifest.glb);var master=Read(folder,manifest.sourceMaster);var rgba=Read(folder,manifest.image);
            var original=ReadOriginalGlb(glb,manifest,rgba);result.rootIdentity=original.nativeStem;
            result.sourceGlbSha256=Hash(glb);result.sourceMasterSha256=Hash(master); Need(manifest.image.width>0 && manifest.image.height>0 && manifest.image.width<=SystemInfo.maxTextureSize && manifest.image.height<=SystemInfo.maxTextureSize,"Original image exceeds this device's maximum texture dimensions; no resizing is allowed");
            Need(rgba.Length==(long)manifest.image.width*manifest.image.height*4 && Enumerable.Range(0,rgba.Length/4).All(i=>rgba[i*4+3]==255),"Complete opaque original RGBA8 data");
            result.importerVersion=UnityEditor.PackageManager.PackageInfo.GetAllRegisteredPackages().Single(p=>p.name=="com.unity.cloud.gltfast").version; Need(result.importerVersion=="6.20.0","Qualified official glTFast 6.20.0 required");
            var directory="Assets/${n.name}Precision_"+Guid.NewGuid().ToString("N"); Need(!AssetDatabase.IsValidFolder(directory),"Existing output is never replaced"); Directory.CreateDirectory(NativeFilePath(directory));result.outputDirectory=directory;
            string source=directory+"/"+original.nativeStem+".glb";result.sourceImportPath=source; WriteFileBytes(source,glb); AssetDatabase.ImportAsset(source,ImportAssetOptions.ForceSynchronousImport|ImportAssetOptions.ForceUpdate);
            var importer=AssetImporter.GetAtPath(source); Need(importer?.GetType().FullName=="GLTFast.Editor.GltfImporter","Official GLB importer unavailable");
            var serialized=new SerializedObject(importer);var readable=serialized.FindProperty("importSettings.texturesReadable");var mip=serialized.FindProperty("importSettings.generateMipMaps");var secondary=serialized.FindProperty("editorImportSettings.generateSecondaryUVSet");Need(readable!=null && mip!=null && secondary!=null,"Pinned official importer configuration changed"); readable.boolValue=true;mip.boolValue=false;secondary.boolValue=false;serialized.ApplyModifiedPropertiesWithoutUndo();importer.SaveAndReimport();
            var prefab=AssetDatabase.LoadAssetAtPath<GameObject>(source); Need(prefab!=null,"Official GLB did not create a native prefab"); instance=(GameObject)PrefabUtility.InstantiatePrefab(prefab);
            VerifyOriginalGlb(instance,original,manifest,result);result.originalGlbMatchedBeforeAdaptation=true;
            result.geometryBeforeSha256=GeometryHash(instance,out result.triangles,out result.meshes,out result.objects); Need(result.triangles==manifest.triangles && result.meshes>0,"Actual complete native triangle count");
            var nativeMaterials=instance.GetComponentsInChildren<Renderer>(true).SelectMany(r=>r.sharedMaterials).Distinct().ToArray();Need(nativeMaterials.Length==1 && nativeMaterials[0]!=null && nativeMaterials[0].shader!=null && nativeMaterials[0].shader.name=="glTF/Unlit","Bounded single-material native unlit profile");
            var texture=new Texture2D(manifest.image.width,manifest.image.height,TextureFormat.RGBA32,false,false){name="${n.name} original atlas",filterMode=FilterMode.Point,wrapModeU=TextureWrapMode.Clamp,wrapModeV=TextureWrapMode.Clamp,anisoLevel=1}; texture.LoadRawTextureData(FlipRows(rgba,manifest.image.width,manifest.image.height));texture.Apply(false,false);
            string texturePath=directory+"/original-atlas.asset";AssetDatabase.CreateAsset(texture,texturePath);
            string originalMaterialName=original.g.materials[0].name;Need(SafeNativeStem(originalMaterialName),"Original material needs a supported native filename; identity is never sanitized silently");var material=new Material(nativeMaterials[0]);material.name=originalMaterialName; material.mainTexture=texture; string materialPath=directory+"/"+originalMaterialName+".mat";AssetDatabase.CreateAsset(material,materialPath);
            foreach(var renderer in instance.GetComponentsInChildren<Renderer>(true)) renderer.sharedMaterials=renderer.sharedMaterials.Select(_=>material).ToArray();
            PrefabUtility.UnpackPrefabInstance(instance,PrefabUnpackMode.Completely,InteractionMode.AutomatedAction);
            result.prefabPath=directory+"/"+original.nativeStem+".prefab"; var saved=PrefabUtility.SaveAsPrefabAsset(instance,result.prefabPath,out bool success);Need(success && saved!=null,"Persistent native prefab save");AssetDatabase.SaveAssets();
            Object.DestroyImmediate(instance);instance=null; AssetDatabase.ImportAsset(result.prefabPath,ImportAssetOptions.ForceSynchronousImport|ImportAssetOptions.ForceUpdate);
            reopened=PrefabUtility.LoadPrefabContents(result.prefabPath);Need(reopened!=null,"Native prefab resource reopen");result.geometryAfterSha256=GeometryHash(reopened,out int afterTriangles,out int afterMeshes,out int afterObjects);
            VerifyOriginalGlb(reopened,original,manifest,result);result.originalGlbMatchedAfterReopen=true;
            result.geometryAndHierarchyUnchanged=result.geometryBeforeSha256==result.geometryAfterSha256 && afterTriangles==result.triangles && afterMeshes==result.meshes && afterObjects==result.objects;Need(result.geometryAndHierarchyUnchanged,"Every imported geometry byte and local hierarchy/TRS retained after adapter Save/reopen");AuditTexture(reopened,manifest,texturePath,result);
            Need(Hash(ReadFileBytes(source))==manifest.glb.sha256 && Hash(ReadFileBytes(manifestPath))==result.sourceManifestSha256 && Hash(Read(folder,manifest.sourceMaster))==result.sourceMasterSha256,"Original input and complete source unchanged");result.nativeSaveReopenVerified=true;result.status="native-adapter-storage-passed-render-gates-open";
        } catch(Exception error) { result.status="failed";result.exception=error.ToString();Debug.LogError(result.exception); }
        finally { if(instance!=null) Object.DestroyImmediate(instance); if(reopened!=null) PrefabUtility.UnloadPrefabContents(reopened); }
        Debug.Log("${n.upper}_UNITY_PRECISION_"+(result.status=="failed"?"FAIL":"PASS")+" "+JsonUtility.ToJson(result));return result;
    }
    [MenuItem("${n.name}/Import precision bundle...")]
    public static void ImportMenu() { string path=EditorUtility.OpenFilePanel("Open ${n.name} Unity precision manifest","","${o.extension}");if(!String.IsNullOrEmpty(path)) { var result=ImportBundle(path);EditorUtility.DisplayDialog("${n.name} precision import",result.status=="failed"?result.exception:result.prefabPath,"OK"); } }
    public static void RunFromEnvironment() { string path=Environment.GetEnvironmentVariable("${n.upper}_UNITY_BUNDLE"), report=Environment.GetEnvironmentVariable("${n.upper}_UNITY_REPORT");Need(!String.IsNullOrEmpty(path) && !String.IsNullOrEmpty(report) && !File.Exists(NativeFilePath(report)),"New external bundle/report paths required");var result=ImportBundle(path);Directory.CreateDirectory(NativeFilePath(Path.GetDirectoryName(Path.GetFullPath(report))));File.WriteAllText(NativeFilePath(report),JsonUtility.ToJson(result,true));EditorApplication.Exit(result.status=="failed"?1:0); }
}
}
`;
}
