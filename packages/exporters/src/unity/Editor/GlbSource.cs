using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace MargoMesh.Unity.Editor {
    /// <summary>A bounded, validated read of a Margo Mesh Studio GLB: JSON, BIN chunk, hierarchy, visibility and animated nodes. glTFast owns all geometry/skin/curve interpretation.</summary>
    internal sealed class GlbSource {
        internal const string Generator = "Margo Mesh Studio";
        internal Dictionary<string, object> root;
        internal List<object> nodes, materials, textures, samplers, animations;
        internal int[] parents;
        internal bool[] visible, moving;
        internal byte[] bytes, binary;
        internal static GlbSource Read(string path) {
            long fileLength = new FileInfo(path).Length;
            if (fileLength < 20 || fileLength > 128L * 1024 * 1024)
                throw new InvalidDataException("GLB size must be between 20 bytes and 128 MiB.");
            byte[] owned = File.ReadAllBytes(path);
            using (var stream = new MemoryStream(owned, false)) {
                // Rechecked on the owned bytes: the file can change between the size probe and the read.
                if (stream.Length < 20 || stream.Length > 128L * 1024 * 1024)
                    throw new InvalidDataException("GLB size must be between 20 bytes and 128 MiB.");
                var header = new byte[20];
                ReadFully(stream, header);
                if (U32(header, 0) != 0x46546c67 || U32(header, 4) != 2 || U32(header, 8) != stream.Length ||
                    U32(header, 16) != 0x4e4f534a)
                    throw new InvalidDataException("Invalid GLB 2 JSON header.");
                uint count = U32(header, 12);
                if (count == 0 || count % 4 != 0 || count > 4 * 1024 * 1024 || count > stream.Length - 20)
                    throw new InvalidDataException("Invalid or oversized GLB JSON chunk.");
                var bytes = new byte[count];
                ReadFully(stream, bytes);
                var doc = Parse(bytes);
                if (Text(Get(Obj(Get(doc, "asset")), "generator")) != Generator)
                    return null;
                if (stream.Length - stream.Position < 8)
                    throw new InvalidDataException("Missing embedded GLB BIN chunk.");
                var binHeader = new byte[8];
                ReadFully(stream, binHeader);
                uint binLength = U32(binHeader, 0);
                if (U32(binHeader, 4) != 0x004e4942 || binLength % 4 != 0 || binLength != stream.Length - stream.Position)
                    throw new InvalidDataException("Invalid embedded GLB BIN chunk.");
                var binary = new byte[binLength];
                ReadFully(stream, binary);
                var value = new GlbSource {
                    bytes = owned, binary = binary, root = doc, nodes = Arr(Get(doc, "nodes")), materials = Arr(Get(doc, "materials")),
                    textures = Arr(Get(doc, "textures")), samplers = Arr(Get(doc, "samplers")), animations = Arr(Get(doc, "animations"))
                };
                value.Validate();
                return value;
            }
        }
        static uint U32(byte[] b, int p) => (uint)b[p] | (uint)b[p + 1] << 8 | (uint)b[p + 2] << 16 | (uint)b[p + 3] << 24;
        static void ReadFully(Stream stream, byte[] bytes) {
            int offset = 0, count;
            while (offset < bytes.Length && (count = stream.Read(bytes, offset, bytes.Length - offset)) > 0)
                offset += count;
            if (offset != bytes.Length)
                throw new EndOfStreamException();
        }
        void Validate() {
            // Material, texture, sampler and clip metadata are checked strictly by ImportProfile.ValidateSource.
            if (nodes.Count > 200000 || animations.Count > 4096)
                throw new InvalidDataException("GLB has more than 200000 nodes or 4096 animations; split the asset.");
            parents = new int[nodes.Count];
            visible = new bool[nodes.Count];
            moving = new bool[nodes.Count];
            for (int i = 0; i < nodes.Count; i++) {
                parents[i] = -1;
                visible[i] = true;
            }
            for (int i = 0; i < nodes.Count; i++) {
                var node = Obj(nodes[i]);
                foreach (var child in Arr(Get(node, "children"))) {
                    int index = Index(child, nodes.Count);
                    if (parents[index] >= 0)
                        throw new InvalidDataException("A node has multiple parents.");
                    parents[index] = i;
                }
                var visibility = Obj(Get(Obj(Get(node, "extensions")), "KHR_node_visibility"));
                if (visibility.TryGetValue("visible", out var flag))
                    visible[i] = Bool(flag);
            }
            foreach (var animation in animations) {
                var anim = Obj(animation);
                foreach (var channel in Arr(Get(anim, "channels"))) {
                    var target = Obj(Get(Obj(channel), "target"));
                    if (target.TryGetValue("node", out var index))
                        moving[Index(index, nodes.Count)] = true;
                }
            }
            // Iterative, bounded parent walks reject cycles without risking the C# stack.
            var finished = new bool[nodes.Count];
            var path = new List<int>();
            var visiting = new HashSet<int>();
            for (int i = 0; i < nodes.Count; i++) {
                path.Clear();
                visiting.Clear();
                int index = i;
                while (index >= 0 && !finished[index]) {
                    if (!visiting.Add(index))
                        throw new InvalidDataException("Cyclic node hierarchy.");
                    path.Add(index);
                    index = parents[index];
                }
                for (int j = path.Count - 1; j >= 0; j--) {
                    index = path[j];
                    int parent = parents[index];
                    if (parent >= 0) {
                        visible[index] &= visible[parent];
                        moving[index] |= moving[parent];
                    }
                    finished[index] = true;
                }
            }
        }
        // Typed JSON accessors. A missing object or array reads as empty; a wrong type throws.
        internal static object Get(Dictionary<string, object> map, string key) => map.TryGetValue(key, out var value) ? value : null;
        internal static Dictionary<string, object> Obj(object value) => value == null ? new Dictionary<string, object>() : value as Dictionary<string, object> ?? throw new InvalidDataException("Expected JSON object.");
        internal static List<object> Arr(object value) => value == null ? new List<object>() : value as List<object> ?? throw new InvalidDataException("Expected JSON array.");
        internal static string Text(object value) => value == null ? "" : value as string ?? throw new InvalidDataException("Expected JSON string.");
        internal static bool Bool(object value) => value is bool b ? b : throw new InvalidDataException("Expected JSON boolean.");
        internal static double Number(object value) => value is double n ? n : throw new InvalidDataException("Expected JSON number.");
        internal static int Index(object value, int count) {
            double n = Number(value);
            if (n < 0 || n >= count || n != Math.Floor(n))
                throw new InvalidDataException("Source index " + n + " is outside 0.." + (count - 1) + "; repair the GLB.");
            return (int)n;
        }
        internal static Dictionary<string, object> Parse(byte[] bytes) {
            if (bytes.Length == 0 || bytes.Length > 4 * 1024 * 1024)
                throw new InvalidDataException("JSON file is empty or larger than 4 MiB; export it again.");
            return Obj(new Json(new UTF8Encoding(false, true).GetString(bytes)).Read());
        }

        /// <summary>Strict, bounded RFC 8259 reader: no duplicate keys, depth 64, at most one million values, finite numbers.</summary>
        sealed class Json {
            readonly string text; int at, values;
            internal Json(string text) {
                this.text = text;
            }
            internal object Read() {
                var value = Value(0);
                White();
                if (at != text.Length)
                    Fail();
                return value;
            }
            void White() {
                while (at < text.Length && (text[at] == ' ' || text[at] == '\t' || text[at] == '\r' || text[at] == '\n'))
                    at++;
            }
            void Fail() => throw new InvalidDataException("Malformed GLB JSON at character " + at + ".");
            object Value(int depth) {
                White();
                if (depth > 64 || ++values > 1000000 || at == text.Length) {
                    Fail();
                    return null;
                }
                char c = text[at];
                if (c == '{') {
                    at++;
                    var result = new Dictionary<string, object>(StringComparer.Ordinal);
                    White();
                    if (Take('}'))
                        return result;
                    do {
                        White();
                        if (at == text.Length || text[at] != '"')
                            Fail();
                        var key = String();
                        White();
                        if (!Take(':'))
                            Fail();
                        if (result.ContainsKey(key))
                            Fail();
                        result.Add(key, Value(depth + 1));
                        White();
                        if (Take('}'))
                            return result;
                    } while (Take(','));
                    Fail();
                }
                if (c == '[') {
                    at++;
                    var result = new List<object>();
                    White();
                    if (Take(']'))
                        return result;
                    do {
                        result.Add(Value(depth + 1));
                        White();
                        if (Take(']'))
                            return result;
                    } while (Take(','));
                    Fail();
                }
                if (c == '"')
                    return String();
                foreach (string literal in new[] { "true", "false", "null" })
                    if (at + literal.Length <= text.Length && string.CompareOrdinal(text, at, literal, 0, literal.Length) == 0) {
                        at += literal.Length;
                        return literal == "null" ? null : (object)(literal == "true");
                    }
                int start = at;
                Take('-');
                if (!Take('0')) {
                    int digits = at;
                    while (Digit())
                        at++;
                    if (digits == at)
                        Fail();
                }
                if (Take('.')) {
                    int digits = at;
                    while (Digit())
                        at++;
                    if (digits == at)
                        Fail();
                }
                if (Take('e') || Take('E')) {
                    if (!Take('+'))
                        Take('-');
                    int digits = at;
                    while (Digit())
                        at++;
                    if (digits == at)
                        Fail();
                }
                if (!double.TryParse(text.Substring(start, at - start), NumberStyles.Float, CultureInfo.InvariantCulture, out double number) || double.IsNaN(number) || double.IsInfinity(number))
                    Fail();
                return number;
            }
            bool Digit() => at < text.Length && text[at] >= '0' && text[at] <= '9';
            bool Take(char c) {
                if (at >= text.Length || text[at] != c)
                    return false;
                at++;
                return true;
            }
            string String() {
                if (!Take('"'))
                    Fail();
                var result = new StringBuilder();
                while (at < text.Length) {
                    char c = text[at++];
                    if (c == '"')
                        return result.ToString();
                    if (c < 32)
                        Fail();
                    if (c == '\\') {
                        if (at == text.Length)
                            Fail();
                        c = text[at++];
                        switch (c) {
                            case '"':
                            case '\\':
                            case '/':
                                break;
                            case 'b':
                                c = '\b';
                                break;
                            case 'f':
                                c = '\f';
                                break;
                            case 'n':
                                c = '\n';
                                break;
                            case 'r':
                                c = '\r';
                                break;
                            case 't':
                                c = '\t';
                                break;
                            case 'u':
                                if (at + 4 > text.Length || !ushort.TryParse(text.Substring(at, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out ushort code)) {
                                    Fail();
                                    return null;
                                }
                                c = (char)code;
                                at += 4;
                                break;
                            default:
                                Fail();
                                break;
                        }
                    }
                    result.Append(c);
                    if (result.Length > 1024 * 1024)
                        Fail();
                }
                Fail();
                return null;
            }
        }
    }
}
