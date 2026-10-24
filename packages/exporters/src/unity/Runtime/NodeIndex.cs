using UnityEngine;

namespace MargoMesh.Unity {
    /// <summary>On each generated node: its serialized source identity, never a name-based lookup. Also usable by game-side socket tooling.</summary>
    [AddComponentMenu("")]
    public sealed class NodeIndex : MonoBehaviour {
        /// <summary>Index of the source glTF node.</summary>
        [HideInInspector] public int nodeIndex;
        /// <summary>The source node's <c>extras.id</c>.</summary>
        [HideInInspector] public string sourceId;
    }
}
