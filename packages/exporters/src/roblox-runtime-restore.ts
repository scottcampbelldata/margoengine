// Roblox Luau that rebuilds exact live geometry from a persistent source folder with EditableMesh and EditableImage.
import { nativeAppNames } from './native-names.js';
import { ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK } from './roblox-runtime.js';

/**
 * The source folder's `Restore` ModuleScript. Requiring it returns a function; calling it checks the manifest
 * against `manifestSha256`, decodes every payload chunk and builds the meshes and images live, tagging them with
 * `<appName>*` attributes. EditableMesh and EditableImage do not serialize into a saved place, so keep the folder and
 * call Restore again after reopening. It performs no HTTP, upload or source change.
 * @throws TypeError for an invalid `appName` or a `manifestSha256` that is not 64 lower-case hex digits.
 */
export function createRobloxRuntimeRestore(manifestSha256: string, options: { appName: string }): string {
  const n = nativeAppNames(options?.appName);
  if (typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifestSha256))
    throw new TypeError("manifestSha256 must be 64 lower-case hex digits; pass the runtime manifest's SHA-256");
  return String.raw`-- ${n.name} persistent source / explicitly restored live geometry, version 1 candidate.
-- Import this source Folder, then call require(sourceFolder.Restore)().
-- EditableMesh/EditableImage do not serialize into a saved place. Keep this source Folder
-- and rerun Restore after reopening. This performs no HTTP, upload or source mutation.
-- Native Roblox lighting was explicitly accepted; no unlit/material parity claim.
local EXPECTED_MANIFEST_SHA = "${manifestSha256}"
local source = script.Parent
local AS = game:GetService("AssetService")
local ES = game:GetService("EncodingService")
local HS = game:GetService("HttpService")
local function hash(bytes)
    local digest = ES:ComputeBufferHash(bytes, Enum.HashAlgorithm.Sha256)
    local hex = {}
    for i = 0, buffer.len(digest) - 1 do hex[i + 1] = string.format("%02x", buffer.readu8(digest, i)) end
    return table.concat(hex)
end
local function decode(folder, expectedParts)
    assert(folder and folder:IsA("Folder"), "Missing source payload Folder")
    local children = folder:GetChildren()
    assert(expectedParts == nil or #children == expectedParts, "Source fragment count changed")
    local values = {}
    for i = 1, #children do
        local part = folder:FindFirstChild(string.format("%06d", i - 1))
        assert(part and part:IsA("StringValue"), "Missing numbered source fragment")
        assert(#part.Value > 0 and #part.Value <= 49152, "Invalid source fragment size")
        values[i] = part.Value
    end
    assert(#values > 0, "Empty source payload")
    return ES:Base64Decode(buffer.fromstring(table.concat(values)))
end
local function finite(n)
    assert(type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge, "Nonfinite source scalar")
    return n
end
local function readf(bytes, at) return finite(buffer.readf32(bytes, at)) end
return function()
    local manifestBytes = decode(source:FindFirstChild("Manifest"))
    assert(hash(manifestBytes) == EXPECTED_MANIFEST_SHA, "Source manifest hash changed")
    local manifest = HS:JSONDecode(buffer.tostring(manifestBytes))
    assert(manifest.version == 1 and manifest.profileId == "roblox-editable-source-v1-candidate", "Unsupported source profile")
    assert(manifest.triangleBudget == ${ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK}, "Unsupported source runtime triangle budget")
    assert(manifest.persistence == "source-restored-live-objects" and manifest.nativeLighting == true, "Source policy changed")
    assert(source.Name == manifest.sourceFolderName, "Source Folder identity changed")
    assert(not workspace:FindFirstChild(manifest.outputName), "Output exists; restore refuses replacement")
    local payloads = assert(source:FindFirstChild("Payloads"), "Missing source Payloads")
    local function payload(row)
        local bytes = decode(payloads:FindFirstChild(row.id), row.partCount)
        assert(buffer.len(bytes) == row.byteLength and hash(bytes) == row.sha256, "Source payload identity changed: " .. row.id)
        return bytes
    end
    -- Track only allocations owned by this call. Source and existing workspace objects
    -- are never deleted, reparented or edited, including on allocation/readback failure.
    local owned, outer = {}, nil
    local stage = "create detached output"
    local function track(instance)
        assert(instance ~= nil, "Roblox native allocation returned nil; source remains intact")
        table.insert(owned, instance)
        return instance
    end
    local function cleanup()
        for i = #owned, 1, -1 do pcall(function() owned[i]:Destroy() end) end
    end
    local ok, result = xpcall(function()
        outer = track(Instance.new("Model"))
        outer.Name = manifest.outputName
        outer:SetAttribute("${n.name}RuntimeManifestSha256", EXPECTED_MANIFEST_SHA)
        outer:SetAttribute("${n.name}SourceSnapshotSha256", manifest.sourceSnapshotSha256)
        outer:SetAttribute("${n.name}SourceMasterSha256", manifest.sourceMaster.sha256)
        outer:SetAttribute("${n.name}LiveObjectsNotSerialized", true)
        outer:SetAttribute("${n.name}NativeLightingUserApproved", true)
        outer:SetAttribute("${n.name}AppearanceQualified", false)
        outer:SetAttribute("${n.name}ProfileId", manifest.profileId)
        local images = {}
        for imageIndex, row in ipairs(manifest.images) do
            local imageStage = "image " .. imageIndex
            stage = imageStage .. " verify source payload"
            assert(row.width >= 1 and row.width <= 1024 and row.height >= 1 and row.height <= 1024, "Unsupported exact image dimensions")
            local bytes = payload(row.payload)
            assert(buffer.len(bytes) == row.width * row.height * 4 and hash(bytes) == row.rgbaSha256, "Incomplete original source RGBA")
            stage = imageStage .. " CreateEditableImage"
            local image = track(AS:CreateEditableImage({Size = Vector2.new(row.width, row.height)}))
            stage = imageStage .. " WritePixelsBuffer"
            image:WritePixelsBuffer(Vector2.zero, image.Size, bytes)
            stage = imageStage .. " ReadPixelsBuffer full hash"
            assert(hash(image:ReadPixelsBuffer(Vector2.zero, image.Size)) == row.rgbaSha256, "Live full image pixels differ from source")
            images[row.imageId] = image
        end
        stage = "create detached logical hierarchy"
        local owners = {}
        for _, row in ipairs(manifest.objects) do
            assert(owners[row.id] == nil, "Duplicate source object identity")
            local owner = track(Instance.new("Model"))
            owner.Name = row.name
            owner:SetAttribute("${n.name}SourceObjectId", row.id)
            owners[row.id] = owner
        end
        for _, row in ipairs(manifest.objects) do
            owners[row.id].Parent = row.parentId and assert(owners[row.parentId], "Missing source parent") or outer
        end
        local meshCount, triangleCount, vertexCount = 0, 0, 0
        for _, row in ipairs(manifest.chunks) do
            local chunkStage = "chunk " .. row.chunkIndex
            stage = chunkStage .. " verify source payload"
            assert(row.vertexCount > 0 and row.vertexCount <= ${ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK * 3} and row.triangleCount > 0 and row.triangleCount <= ${ROBLOX_RUNTIME_TRIANGLES_PER_CHUNK}, "Unsupported native mesh allocation limits")
            local bytes = payload(row.payload)
            assert(buffer.len(bytes) == row.vertexCount * 48 + row.triangleCount * 12, "Incomplete associated Float32/index streams")
            stage = chunkStage .. " CreateEditableMesh"
            local em = track(AS:CreateEditableMesh())
            local vertices, normals, uvs, colors = {}, {}, {}, {}
            -- EditableMesh starts with a default UV entry. Allocating one attribute
            -- for every deindexed source corner can exhaust that pool at 60,000.
            -- Share ONLY bit-identical attributes; all source vertices and indexed
            -- triangles remain distinct. Raw words retain signed-zero distinctions.
            local normalCache, uvCache, colorCache = {}, {}, {}
            local normalCount, uvCount, colorCount = 0, 0, 0
            for i = 1, row.vertexCount do
                local at = (i - 1) * 48
                stage = chunkStage .. " AddVertex " .. i .. "/" .. row.vertexCount
                vertices[i] = em:AddVertex(Vector3.new(readf(bytes, at), readf(bytes, at + 4), readf(bytes, at + 8)))
                stage = chunkStage .. " AddNormal " .. i .. "/" .. row.vertexCount
                local normalKey = string.format("%08x%08x%08x", buffer.readu32(bytes, at + 12), buffer.readu32(bytes, at + 16), buffer.readu32(bytes, at + 20))
                local normalId = normalCache[normalKey]
                if normalId == nil then
                    normalId = em:AddNormal(Vector3.new(readf(bytes, at + 12), readf(bytes, at + 16), readf(bytes, at + 20)))
                    normalCache[normalKey] = normalId
                    normalCount += 1
                end
                normals[i] = normalId
                stage = chunkStage .. " AddUV " .. i .. "/" .. row.vertexCount
                local uvKey = string.format("%08x%08x", buffer.readu32(bytes, at + 24), buffer.readu32(bytes, at + 28))
                local uvId = uvCache[uvKey]
                if uvId == nil then
                    uvId = em:AddUV(Vector2.new(readf(bytes, at + 24), readf(bytes, at + 28)))
                    uvCache[uvKey] = uvId
                    uvCount += 1
                end
                uvs[i] = uvId
                stage = chunkStage .. " AddColor " .. i .. "/" .. row.vertexCount
                local colorKey = string.format("%08x%08x%08x%08x", buffer.readu32(bytes, at + 32), buffer.readu32(bytes, at + 36), buffer.readu32(bytes, at + 40), buffer.readu32(bytes, at + 44))
                local colorId = colorCache[colorKey]
                if colorId == nil then
                    colorId = em:AddColor(Color3.new(readf(bytes, at + 32), readf(bytes, at + 36), readf(bytes, at + 40)), readf(bytes, at + 44))
                    colorCache[colorKey] = colorId
                    colorCount += 1
                end
                colors[i] = colorId
                stage = chunkStage .. " original native tuple readback " .. i .. "/" .. row.vertexCount
                local p, n, uv, c, a = em:GetPosition(vertices[i]), em:GetNormal(normals[i]), em:GetUV(uvs[i]), em:GetColor(colors[i]), em:GetColorAlpha(colors[i])
                assert(p.X == readf(bytes, at) and p.Y == readf(bytes, at + 4) and p.Z == readf(bytes, at + 8), "Native vertex changed")
                assert(math.abs(n.X - readf(bytes, at + 12)) <= 0.00001 and math.abs(n.Y - readf(bytes, at + 16)) <= 0.00001 and math.abs(n.Z - readf(bytes, at + 20)) <= 0.00001, "Native normal changed")
                assert(uv.X == readf(bytes, at + 24) and uv.Y == readf(bytes, at + 28), "Native UV changed")
                assert(c.R == readf(bytes, at + 32) and c.G == readf(bytes, at + 36) and c.B == readf(bytes, at + 40) and a == readf(bytes, at + 44), "Native RGBA changed")
            end
            for i = 0, row.triangleCount - 1 do
                local at = row.vertexCount * 48 + i * 12
                local a, b, c = buffer.readu32(bytes, at) + 1, buffer.readu32(bytes, at + 4) + 1, buffer.readu32(bytes, at + 8) + 1
                assert(a <= row.vertexCount and b <= row.vertexCount and c <= row.vertexCount, "Native triangle index out of range")
                stage = chunkStage .. " AddTriangle " .. (i + 1) .. "/" .. row.triangleCount
                local f = em:AddTriangle(vertices[a], vertices[b], vertices[c])
                stage = chunkStage .. " native face attribute assignment " .. (i + 1) .. "/" .. row.triangleCount
                em:SetFaceNormals(f, {normals[a], normals[b], normals[c]})
                em:SetFaceUVs(f, {uvs[a], uvs[b], uvs[c]})
                em:SetFaceColors(f, {colors[a], colors[b], colors[c]})
                local fv, fn, fu, fc = em:GetFaceVertices(f), em:GetFaceNormals(f), em:GetFaceUVs(f), em:GetFaceColors(f)
                for j, index in ipairs({a, b, c}) do
                    assert(fv[j] == vertices[index] and fn[j] == normals[index] and fu[j] == uvs[index] and fc[j] == colors[index], "Native associated triangle/winding changed")
                end
            end
            stage = chunkStage .. " RemoveUnused and source topology checks"
            em:RemoveUnused()
            assert(#em:GetVertices() == row.vertexCount and #em:GetFaces() == row.triangleCount, "Native topology count changed")
            assert(#em:GetNormals() == normalCount and #em:GetUVs() == uvCount and #em:GetColors() == colorCount, "Native exact attribute pool count changed")
            stage = chunkStage .. " CreateMeshPartAsync"
            local part = track(AS:CreateMeshPartAsync(Content.fromObject(em), {RenderFidelity = Enum.RenderFidelity.Precise}))
            stage = chunkStage .. " native MeshPart settings and identity"
            assert(part.Parent == nil and part.MeshContent.SourceType == Enum.ContentSourceType.Object and part.MeshContent.Object == em, "New MeshPart lost native object identity")
            part.Name = "Chunk_" .. string.format("%06d", row.chunkIndex)
            part.Size = part.MeshSize
            part.CFrame = CFrame.new(finite(row.centerStuds[1]), finite(row.centerStuds[2]), finite(row.centerStuds[3]))
            part.DoubleSided = row.doubleSided
            part.Color = Color3.new(1, 1, 1)
            part.Transparency = 0
            part.Anchored = true
            part:SetAttribute("${n.name}SourceObjectId", row.objectId)
            part:SetAttribute("${n.name}SourceChunkIndex", row.chunkIndex)
            part:SetAttribute("${n.name}SourcePayloadSha256", row.payload.sha256)
            assert(part.Size == part.MeshSize and part.RenderFidelity == Enum.RenderFidelity.Precise and part.DoubleSided == row.doubleSided, "Native render settings changed")
            assert(part.CFrame == CFrame.new(row.centerStuds[1], row.centerStuds[2], row.centerStuds[3]), "Native source-derived placement changed")
            -- Read the actual MeshPart content back through the consumer API, rather
            -- than treating successful setters on the original EditableMesh as proof.
            -- Corner keys omit normals so native normalization may differ only within
            -- the declared component tolerance. Winding is cyclic, never reversible.
            stage = chunkStage .. " readback copy CreateEditableMeshAsync"
            local copy = track(AS:CreateEditableMeshAsync(part.MeshContent, {FixedSize = true}))
            stage = chunkStage .. " readback copy topology and associated source matching"
            local copyVertexCount, copyFaceCount = #copy:GetVertices(), #copy:GetFaces()
            assert(copyVertexCount == row.vertexCount and copyFaceCount == row.triangleCount,
                "Native MeshPart readback topology changed: vertices=" .. copyVertexCount .. "/" .. row.vertexCount
                .. " faces=" .. copyFaceCount .. "/" .. row.triangleCount
                .. " normals=" .. #copy:GetNormals() .. "/" .. normalCount
                .. " uvs=" .. #copy:GetUVs() .. "/" .. uvCount
                .. " colors=" .. #copy:GetColors() .. "/" .. colorCount)
            local function numberKey(n) return n == 0 and "0" or string.format("%.9g", n) end
            local function key(values)
                local pieces = {}
                for i, value in ipairs(values) do pieces[i] = numberKey(value) end
                return table.concat(pieces, ",")
            end
            local function cycle(keys)
                local best = nil
                for i = 1, 3 do
                    local candidate = keys[i] .. ";" .. keys[i % 3 + 1] .. ";" .. keys[(i + 1) % 3 + 1]
                    if best == nil or candidate < best then best = candidate end
                end
                return best
            end
            local expected = {}
            for i = 0, row.triangleCount - 1 do
                local keys, ns = {}, {}
                for corner = 0, 2 do
                    local index = buffer.readu32(bytes, row.vertexCount * 48 + i * 12 + corner * 4)
                    local at = index * 48
                    keys[corner + 1] = key({readf(bytes, at), readf(bytes, at + 4), readf(bytes, at + 8), readf(bytes, at + 24), readf(bytes, at + 28), readf(bytes, at + 32), readf(bytes, at + 36), readf(bytes, at + 40), readf(bytes, at + 44)})
                    ns[corner + 1] = Vector3.new(readf(bytes, at + 12), readf(bytes, at + 16), readf(bytes, at + 20))
                end
                local signature = cycle(keys)
                if expected[signature] == nil then expected[signature] = {} end
                table.insert(expected[signature], {keys = keys, normals = ns})
            end
            for faceIndex, face in ipairs(copy:GetFaces()) do
                stage = chunkStage .. " readback copy face " .. faceIndex .. "/" .. row.triangleCount
                local vs, ns, us, cs = copy:GetFaceVertices(face), copy:GetFaceNormals(face), copy:GetFaceUVs(face), copy:GetFaceColors(face)
                assert(#vs == 3 and #ns == 3 and #us == 3 and #cs == 3, "Native MeshPart face is not a complete associated triangle")
                local keys, normalValues = {}, {}
                for corner = 1, 3 do
                    local p, uv, c, a = copy:GetPosition(vs[corner]), copy:GetUV(us[corner]), copy:GetColor(cs[corner]), copy:GetColorAlpha(cs[corner])
                    keys[corner] = key({p.X, p.Y, p.Z, uv.X, uv.Y, c.R, c.G, c.B, a})
                    normalValues[corner] = copy:GetNormal(ns[corner])
                end
                local bucket = expected[cycle(keys)]
                assert(bucket and #bucket > 0, "Native MeshPart associated triangle, UV, color or winding changed")
                local matched = nil
                for candidate = #bucket, 1, -1 do
                    for offset = 0, 2 do
                        local same = true
                        for corner = 1, 3 do
                            local sourceCorner = (corner + offset - 1) % 3 + 1
                            local n, reference = normalValues[corner], bucket[candidate].normals[sourceCorner]
                            if keys[corner] ~= bucket[candidate].keys[sourceCorner] or math.abs(n.X - reference.X) > 0.00001 or math.abs(n.Y - reference.Y) > 0.00001 or math.abs(n.Z - reference.Z) > 0.00001 then same = false; break end
                        end
                        if same then matched = candidate; break end
                    end
                    if matched then break end
                end
                assert(matched, "Native MeshPart corner normals changed beyond tolerance")
                table.remove(bucket, matched)
            end
            for _, bucket in pairs(expected) do assert(#bucket == 0, "Native MeshPart omitted source triangles") end
            stage = chunkStage .. " release owned readback copy"
            copy:Destroy()
            owned[#owned] = nil
            if row.imageId then
                stage = chunkStage .. " CreateSurfaceAppearanceAsync and source image binding"
                local image = assert(images[row.imageId], "Missing original image identity")
                local surface = track(AS:CreateSurfaceAppearanceAsync({ColorMap = Content.fromObject(image)}))
                surface.Name = "${n.name}_NativeLighting_OriginalPixels"
                surface.ResampleMode = Enum.ResamplerMode.Pixelated
                surface.Color = Color3.new(1, 1, 1)
                surface.AlphaMode = Enum.AlphaMode.Overlay
                assert(surface.ColorMapContent.SourceType == Enum.ContentSourceType.Object and surface.ColorMapContent.Object == image and surface.ResampleMode == Enum.ResamplerMode.Pixelated, "Native image identity or sampler changed")
                surface.Parent = part
            end
            stage = chunkStage .. " attach to detached logical owner"
            part.Parent = assert(owners[row.objectId], "Missing source owner")
            meshCount += 1
            triangleCount += row.triangleCount
            vertexCount += row.vertexCount
            if meshCount % 10 == 0 then print("${n.upper}_RUNTIME_RESTORE progress meshes=" .. meshCount .. " triangles=" .. triangleCount) end
        end
        stage = "publish completed detached output"
        assert(not workspace:FindFirstChild(manifest.outputName), "Concurrent output exists; restore refuses replacement")
        outer:SetAttribute("${n.name}TriangleCount", triangleCount)
        outer:SetAttribute("${n.name}VertexCount", vertexCount)
        -- All source hashes and native data checks completed before publishing this model.
        outer.Parent = workspace
        print("${n.upper}_RUNTIME_RESTORE PASS manifest=" .. EXPECTED_MANIFEST_SHA .. " meshes=" .. meshCount .. " triangles=" .. triangleCount .. " vertices=" .. vertexCount .. " persistenceRequiresRestore=true")
        return outer
    end, function(message) return debug.traceback(tostring(message), 2) end)
    if not ok then cleanup(); error("${n.name} restore failed at " .. stage .. "; newly allocated objects cleaned: " .. result, 0) end
    -- Retain live native resources for the output lifetime and release only these owned
    -- allocations if this output is later deliberately destroyed by its owner.
    result.Destroying:Connect(function()
        for _, instance in ipairs(owned) do
            if instance ~= result and (instance:IsA("EditableMesh") or instance:IsA("EditableImage")) then pcall(function() instance:Destroy() end) end
        end
    end)
    return result
end
`;
}
