using UnityEngine;

namespace MargoMesh.Unity {
    /// <summary>On the generated prefab root: the owned resources of one target import.</summary>
    [AddComponentMenu("")]
    public sealed class ImportIndex : MonoBehaviour {
        /// <summary>The owned atlas material (one).</summary>
        [HideInInspector] public Material[] materials;
        /// <summary>The owned atlas texture (one).</summary>
        [HideInInspector] public Texture2D[] textures;
        /// <summary>The owned clips, in source animation order.</summary>
        [HideInInspector] public AnimationClip[] clips;
    }
}
