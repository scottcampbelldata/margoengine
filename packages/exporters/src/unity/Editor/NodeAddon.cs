using System;
using System.Collections.Generic;
using GLTFast;
using GLTFast.Addons;
using UnityEngine;

namespace MargoMesh.Unity.Editor {
    /// <summary>glTFast add-on that tags each imported node and mesh with its source index and <c>extras.id</c>. Never registered globally; one validated import owns this instance.</summary>
    internal sealed class NodeAddon : ImportAddonInstance {
        readonly ImportProfile profile;
        readonly List<Action> unsubscribe = new List<Action>();
        GltfImportBase importer;
        internal NodeAddon(ImportProfile profile) {
            this.profile = profile;
        }
        public override bool SupportsGltfExtension(string extensionName) => false;
        public override void Inject(GltfImportBase gltfImport) {
            if (importer != null && importer != gltfImport)
                throw new InvalidOperationException("Margo addon cannot be shared between imports.");
            importer = gltfImport;
            gltfImport.AddImportAddonInstance(this);
        }
        public override void Inject(IInstantiator instantiator) {
            if (importer == null || !(instantiator is GameObjectInstantiator target))
                throw new InvalidOperationException("Strict target requires its own public GameObjectInstantiator.");
            void Node(uint index, GameObject go) {
                var marker = go.AddComponent<NodeIndex>();
                marker.nodeIndex = SourceNode(index);
                marker.sourceId = profile.SourceId(marker.nodeIndex);
            }
            void Mesh(GameObject go, uint index, string name, MeshResult result, uint[] joints, uint? rootJoint, float[] weights, int numeration) {
                var marker = go.AddComponent<MeshIndex>();
                marker.nodeIndex = SourceNode(index);
                marker.sourceId = profile.SourceId(marker.nodeIndex);
                marker.meshNumeration = numeration;
                marker.materialIndices = (int[])result.materialIndices.Clone();
            }
            target.NodeCreated += Node;
            target.MeshAdded += Mesh;
            Action remove = () => {
                target.NodeCreated -= Node;
                target.MeshAdded -= Mesh;
            };
            target.EndSceneCompleted += remove;
            unsubscribe.Add(() => {
                remove();
                target.EndSceneCompleted -= remove;
            });
        }
        /// <summary>A glTFast node index checked against the validated source.</summary>
        int SourceNode(uint index) {
            if (index >= (uint)profile.glb.nodes.Count)
                throw new InvalidOperationException("Imported node index " + index + " is outside the validated source.");
            return (int)index;
        }
        public override void Dispose() {
            foreach (var remove in unsubscribe)
                remove();
            unsubscribe.Clear();
            importer = null;
        }
    }
}
