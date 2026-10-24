using UnityEngine;

namespace MargoMesh.Unity {
    /// <summary>On each generated mesh renderer: its source node and glTFast mesh number, and its renderer policy.</summary>
    [AddComponentMenu("")]
    public sealed class MeshIndex : MonoBehaviour {
        /// <summary>Index of the source glTF node.</summary>
        [HideInInspector] public int nodeIndex;
        /// <summary>The source node's <c>extras.id</c>.</summary>
        [HideInInspector] public string sourceId;
        /// <summary>glTFast's mesh number within the source mesh.</summary>
        [HideInInspector] public int meshNumeration;
        /// <summary>Source material index of each submesh.</summary>
        [HideInInspector] public int[] materialIndices;
        /// <summary>True once the companion generated this renderer.</summary>
        [HideInInspector] public bool companionGenerated;
        /// <summary>The renderer state the companion generated (source visibility and collider-only policy).</summary>
        [HideInInspector] public bool generatedRendererEnabled;
        /// <summary>True when the renderer was disabled on the prefab by hand; regeneration keeps it disabled.</summary>
        [HideInInspector] public bool authoredRendererDisabled;
    }
}
