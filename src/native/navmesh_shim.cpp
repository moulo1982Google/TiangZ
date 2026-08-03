#include "navmesh_shim.h"

#include "ChunkyTriMesh.h"
#include "DetourCommon.h"
#include "DetourNavMesh.h"
#include "DetourNavMeshBuilder.h"
#include "DetourNavMeshQuery.h"
#include "DetourTileCache.h"
#include "DetourTileCacheBuilder.h"
#include "Recast.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <string>
#include <vector>

namespace {

constexpr uint8_t kMagic[8] = {'T', 'Z', 'N', 'A', 'V', 'M', '0', '2'};
constexpr uint32_t kFormatVersion = 2;
constexpr unsigned short kWalkFlag = 1;
constexpr int kMaxLayersPerTile = 32;
constexpr int kMaxObstacles = 1024;

struct RawTileCacheCompressor final : dtTileCacheCompressor {
    int maxCompressedSize(const int buffer_size) override { return buffer_size; }

    dtStatus compress(const unsigned char* buffer, const int buffer_size,
                      unsigned char* compressed, const int max_compressed_size,
                      int* compressed_size) override {
        if (buffer_size > max_compressed_size) return DT_FAILURE | DT_BUFFER_TOO_SMALL;
        std::memcpy(compressed, buffer, static_cast<size_t>(buffer_size));
        *compressed_size = buffer_size;
        return DT_SUCCESS;
    }

    dtStatus decompress(const unsigned char* compressed, const int compressed_size,
                        unsigned char* buffer, const int max_buffer_size,
                        int* buffer_size) override {
        if (compressed_size > max_buffer_size) return DT_FAILURE | DT_BUFFER_TOO_SMALL;
        std::memcpy(buffer, compressed, static_cast<size_t>(compressed_size));
        *buffer_size = compressed_size;
        return DT_SUCCESS;
    }
};

struct WalkableMeshProcess final : dtTileCacheMeshProcess {
    void process(dtNavMeshCreateParams* params, unsigned char* poly_areas,
                 unsigned short* poly_flags) override {
        // TileCache保留Area供后续地形代价扩展；当前所有可行走面使用统一Flag。
        // TileCache preserves areas for future costs; every current walkable polygon shares one flag.
        for (int index = 0; index < params->polyCount; ++index) {
            if (poly_areas[index] == DT_TILECACHE_WALKABLE_AREA) poly_areas[index] = 0;
            poly_flags[index] = kWalkFlag;
        }
    }
};

void set_error(char* target, size_t capacity, const std::string& message) {
    if (target == nullptr || capacity == 0) return;
    const size_t length = std::min(capacity - 1, message.size());
    std::memcpy(target, message.data(), length);
    target[length] = '\0';
}

void write_u32(std::vector<uint8_t>& output, uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) output.push_back(static_cast<uint8_t>(value >> shift));
}

void write_u64(std::vector<uint8_t>& output, uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8) output.push_back(static_cast<uint8_t>(value >> shift));
}

void write_f32(std::vector<uint8_t>& output, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    write_u32(output, bits);
}

bool read_u32(const uint8_t*& cursor, const uint8_t* end, uint32_t& value) {
    if (static_cast<size_t>(end - cursor) < 4) return false;
    value = static_cast<uint32_t>(cursor[0]) |
            (static_cast<uint32_t>(cursor[1]) << 8) |
            (static_cast<uint32_t>(cursor[2]) << 16) |
            (static_cast<uint32_t>(cursor[3]) << 24);
    cursor += 4;
    return true;
}

bool read_u64(const uint8_t*& cursor, const uint8_t* end, uint64_t& value) {
    if (static_cast<size_t>(end - cursor) < 8) return false;
    value = 0;
    for (int shift = 0; shift < 64; shift += 8) value |= static_cast<uint64_t>(*cursor++) << shift;
    return true;
}

bool read_f32(const uint8_t*& cursor, const uint8_t* end, float& value) {
    uint32_t bits = 0;
    if (!read_u32(cursor, end, bits)) return false;
    std::memcpy(&value, &bits, sizeof(value));
    return true;
}

struct TileBuildData {
    rcHeightfield* solid = nullptr;
    rcCompactHeightfield* compact = nullptr;
    rcHeightfieldLayerSet* layers = nullptr;

    ~TileBuildData() {
        rcFreeHeightField(solid);
        rcFreeCompactHeightfield(compact);
        rcFreeHeightfieldLayerSet(layers);
    }
};

struct CompressedLayer {
    std::vector<uint8_t> bytes;
};

bool build_tile_layers(
    rcContext& context,
    const float* vertices,
    int vertex_count,
    const int* indices,
    int triangle_count,
    const rcChunkyTriMesh& chunky_mesh,
    const TzNavBuildConfig& input,
    int tile_x,
    int tile_y,
    const float* tile_min,
    const float* tile_max,
    std::vector<CompressedLayer>& output,
    std::string& error) {
    rcConfig config{};
    config.cs = input.cell_size;
    config.ch = input.cell_height;
    config.walkableSlopeAngle = input.agent_max_slope;
    config.walkableHeight = static_cast<int>(std::ceil(input.agent_height / config.ch));
    config.walkableClimb = static_cast<int>(std::floor(input.agent_max_climb / config.ch));
    config.walkableRadius = static_cast<int>(std::ceil(input.agent_radius / config.cs));
    config.maxEdgeLen = static_cast<int>(input.edge_max_len / config.cs);
    config.maxSimplificationError = input.edge_max_error;
    config.minRegionArea = static_cast<int>(input.region_min_size * input.region_min_size);
    config.mergeRegionArea = static_cast<int>(input.region_merge_size * input.region_merge_size);
    config.maxVertsPerPoly = input.verts_per_poly;
    config.tileSize = input.tile_size;
    config.borderSize = config.walkableRadius + 3;
    config.width = config.tileSize + config.borderSize * 2;
    config.height = config.tileSize + config.borderSize * 2;
    config.detailSampleDist = input.detail_sample_dist < 0.9f ? 0.0f : config.cs * input.detail_sample_dist;
    config.detailSampleMaxError = config.ch * input.detail_sample_max_error;
    rcVcopy(config.bmin, tile_min);
    rcVcopy(config.bmax, tile_max);
    config.bmin[0] -= config.borderSize * config.cs;
    config.bmin[2] -= config.borderSize * config.cs;
    config.bmax[0] += config.borderSize * config.cs;
    config.bmax[2] += config.borderSize * config.cs;

    TileBuildData build;
    build.solid = rcAllocHeightfield();
    if (build.solid == nullptr || !rcCreateHeightfield(&context, *build.solid, config.width, config.height,
                                                       config.bmin, config.bmax, config.cs, config.ch)) {
        error = "无法创建 Recast 高度场 / failed to create Recast heightfield";
        return false;
    }

    float query_min[2] = {config.bmin[0], config.bmin[2]};
    float query_max[2] = {config.bmax[0], config.bmax[2]};
    std::vector<int> chunk_ids(static_cast<size_t>(chunky_mesh.nnodes));
    const int chunk_count = rcGetChunksOverlappingRect(
        &chunky_mesh, query_min, query_max, chunk_ids.data(), static_cast<int>(chunk_ids.size()));
    if (chunk_count == 0) return true;
    std::vector<unsigned char> triangle_areas(static_cast<size_t>(chunky_mesh.maxTrisPerChunk));
    for (int chunk_index = 0; chunk_index < chunk_count; ++chunk_index) {
        const rcChunkyTriMeshNode& node = chunky_mesh.nodes[chunk_ids[chunk_index]];
        const int* chunk_triangles = &chunky_mesh.tris[node.i * 3];
        std::fill(triangle_areas.begin(), triangle_areas.begin() + node.n, 0);
        rcMarkWalkableTriangles(&context, config.walkableSlopeAngle, vertices, vertex_count,
                                chunk_triangles, node.n, triangle_areas.data());
        if (!rcRasterizeTriangles(&context, vertices, vertex_count, chunk_triangles,
                                  triangle_areas.data(), node.n, *build.solid, config.walkableClimb)) {
            error = "无法栅格化导航三角形 / failed to rasterize navigation triangles";
            return false;
        }
    }

    rcFilterLowHangingWalkableObstacles(&context, config.walkableClimb, *build.solid);
    rcFilterLedgeSpans(&context, config.walkableHeight, config.walkableClimb, *build.solid);
    rcFilterWalkableLowHeightSpans(&context, config.walkableHeight, *build.solid);

    build.compact = rcAllocCompactHeightfield();
    if (build.compact == nullptr ||
        !rcBuildCompactHeightfield(&context, config.walkableHeight, config.walkableClimb, *build.solid, *build.compact)) {
        error = "无法创建紧凑高度场 / failed to build compact heightfield";
        return false;
    }
    if (!rcErodeWalkableArea(&context, config.walkableRadius, *build.compact)) {
        error = "无法按角色半径侵蚀可行走区域 / failed to erode walkable area";
        return false;
    }
    build.layers = rcAllocHeightfieldLayerSet();
    if (build.layers == nullptr ||
        !rcBuildHeightfieldLayers(&context, *build.compact, config.borderSize,
                                  config.walkableHeight, *build.layers)) {
        error = "无法生成动态导航高度层 / failed to build NavMesh heightfield layers";
        return false;
    }
    if (build.layers->nlayers > kMaxLayersPerTile) {
        error = "单个导航Tile的高度层过多 / too many heightfield layers in one navigation tile";
        return false;
    }
    RawTileCacheCompressor compressor;
    for (int layer_index = 0; layer_index < build.layers->nlayers; ++layer_index) {
        const rcHeightfieldLayer& layer = build.layers->layers[layer_index];
        dtTileCacheLayerHeader header{};
        header.magic = DT_TILECACHE_MAGIC;
        header.version = DT_TILECACHE_VERSION;
        header.tx = tile_x;
        header.ty = tile_y;
        header.tlayer = layer_index;
        rcVcopy(header.bmin, layer.bmin);
        rcVcopy(header.bmax, layer.bmax);
        header.width = static_cast<unsigned char>(layer.width);
        header.height = static_cast<unsigned char>(layer.height);
        header.minx = static_cast<unsigned char>(layer.minx);
        header.maxx = static_cast<unsigned char>(layer.maxx);
        header.miny = static_cast<unsigned char>(layer.miny);
        header.maxy = static_cast<unsigned char>(layer.maxy);
        header.hmin = static_cast<unsigned short>(layer.hmin);
        header.hmax = static_cast<unsigned short>(layer.hmax);
        unsigned char* layer_data = nullptr;
        int layer_size = 0;
        if (dtStatusFailed(dtBuildTileCacheLayer(&compressor, &header, layer.heights,
                                                 layer.areas, layer.cons,
                                                 &layer_data, &layer_size))) {
            dtFree(layer_data);
            error = "Detour TileCache高度层生成失败 / failed to build Detour TileCache layer";
            return false;
        }
        output.push_back({std::vector<uint8_t>(layer_data, layer_data + layer_size)});
        dtFree(layer_data);
    }
    return true;
}

struct NavAssetData {
    dtNavMeshParams nav{};
    dtTileCacheParams cache{};
    std::vector<CompressedLayer> layers;
};

bool serialize_asset(const NavAssetData& asset, std::vector<uint8_t>& output) {
    output.insert(output.end(), std::begin(kMagic), std::end(kMagic));
    write_u32(output, kFormatVersion);
    write_u32(output, static_cast<uint32_t>(asset.layers.size()));
    for (float value : asset.nav.orig) write_f32(output, value);
    write_f32(output, asset.nav.tileWidth);
    write_f32(output, asset.nav.tileHeight);
    write_u32(output, static_cast<uint32_t>(asset.nav.maxTiles));
    write_u32(output, static_cast<uint32_t>(asset.nav.maxPolys));
    for (float value : asset.cache.orig) write_f32(output, value);
    write_f32(output, asset.cache.cs);
    write_f32(output, asset.cache.ch);
    write_u32(output, static_cast<uint32_t>(asset.cache.width));
    write_u32(output, static_cast<uint32_t>(asset.cache.height));
    write_f32(output, asset.cache.walkableHeight);
    write_f32(output, asset.cache.walkableRadius);
    write_f32(output, asset.cache.walkableClimb);
    write_f32(output, asset.cache.maxSimplificationError);
    write_u32(output, static_cast<uint32_t>(asset.cache.maxTiles));
    write_u32(output, static_cast<uint32_t>(asset.cache.maxObstacles));
    for (const CompressedLayer& layer : asset.layers) {
        write_u32(output, static_cast<uint32_t>(layer.bytes.size()));
        output.insert(output.end(), layer.bytes.begin(), layer.bytes.end());
    }
    return true;
}

bool deserialize_asset(const uint8_t* data, size_t len, NavAssetData& asset, std::string& error) {
    if (data == nullptr || len < sizeof(kMagic) || std::memcmp(data, kMagic, sizeof(kMagic)) != 0) {
        error = "不是 TiangZ NavMesh 资源 / invalid TiangZ NavMesh magic";
        return false;
    }
    const uint8_t* cursor = data + sizeof(kMagic);
    const uint8_t* end = data + len;
    uint32_t version = 0;
    uint32_t layer_count = 0;
    uint32_t nav_max_tiles = 0;
    uint32_t nav_max_polys = 0;
    uint32_t cache_width = 0;
    uint32_t cache_height = 0;
    uint32_t cache_max_tiles = 0;
    uint32_t cache_max_obstacles = 0;
    if (!read_u32(cursor, end, version) || version != kFormatVersion ||
        !read_u32(cursor, end, layer_count) ||
        !read_f32(cursor, end, asset.nav.orig[0]) || !read_f32(cursor, end, asset.nav.orig[1]) ||
        !read_f32(cursor, end, asset.nav.orig[2]) || !read_f32(cursor, end, asset.nav.tileWidth) ||
        !read_f32(cursor, end, asset.nav.tileHeight) || !read_u32(cursor, end, nav_max_tiles) ||
        !read_u32(cursor, end, nav_max_polys) ||
        !read_f32(cursor, end, asset.cache.orig[0]) || !read_f32(cursor, end, asset.cache.orig[1]) ||
        !read_f32(cursor, end, asset.cache.orig[2]) || !read_f32(cursor, end, asset.cache.cs) ||
        !read_f32(cursor, end, asset.cache.ch) || !read_u32(cursor, end, cache_width) ||
        !read_u32(cursor, end, cache_height) || !read_f32(cursor, end, asset.cache.walkableHeight) ||
        !read_f32(cursor, end, asset.cache.walkableRadius) ||
        !read_f32(cursor, end, asset.cache.walkableClimb) ||
        !read_f32(cursor, end, asset.cache.maxSimplificationError) ||
        !read_u32(cursor, end, cache_max_tiles) || !read_u32(cursor, end, cache_max_obstacles)) {
        error = "NavMesh 资源头损坏或版本不支持 / corrupt or unsupported NavMesh header";
        return false;
    }
    if (layer_count == 0 || layer_count > cache_max_tiles || nav_max_tiles == 0 ||
        nav_max_polys == 0 || cache_max_tiles == 0 || cache_max_obstacles == 0 ||
        cache_width == 0 || cache_height == 0) {
        error = "NavMesh 资源容量字段无效 / invalid NavMesh capacity";
        return false;
    }
    asset.nav.maxTiles = static_cast<int>(nav_max_tiles);
    asset.nav.maxPolys = static_cast<int>(nav_max_polys);
    asset.cache.width = static_cast<int>(cache_width);
    asset.cache.height = static_cast<int>(cache_height);
    asset.cache.maxTiles = static_cast<int>(cache_max_tiles);
    asset.cache.maxObstacles = static_cast<int>(cache_max_obstacles);
    asset.layers.clear();
    asset.layers.reserve(layer_count);
    for (uint32_t index = 0; index < layer_count; ++index) {
        uint32_t data_size = 0;
        if (!read_u32(cursor, end, data_size) ||
            data_size == 0 || static_cast<size_t>(end - cursor) < data_size) {
            error = "NavMesh高度层数据不完整 / truncated NavMesh heightfield layer";
            return false;
        }
        asset.layers.push_back({std::vector<uint8_t>(cursor, cursor + data_size)});
        cursor += data_size;
    }
    if (cursor != end) {
        error = "NavMesh 资源含有未知尾部数据 / unexpected trailing NavMesh data";
        return false;
    }
    return true;
}

}  // namespace

struct TzNavMesh {
    NavAssetData asset;
};

struct TzNavQuery {
    dtNavMesh* mesh = nullptr;
    dtTileCache* tile_cache = nullptr;
    dtNavMeshQuery* query = nullptr;
    dtTileCacheAlloc allocator;
    RawTileCacheCompressor compressor;
    WalkableMeshProcess mesh_process;

    ~TzNavQuery() {
        dtFreeNavMeshQuery(query);
        dtFreeTileCache(tile_cache);
        dtFreeNavMesh(mesh);
    }
};

extern "C" int32_t tz_navmesh_build(
    const float* vertices,
    int32_t vertex_count,
    const int32_t* indices,
    int32_t triangle_count,
    const TzNavBuildConfig* config,
    TzNavBytes* output,
    char* error,
    size_t error_capacity) {
    if (vertices == nullptr || indices == nullptr || config == nullptr || output == nullptr ||
        vertex_count < 3 || triangle_count < 1 || config->cell_size <= 0.0f ||
        config->cell_height <= 0.0f || config->tile_size <= 0) {
        set_error(error, error_capacity, "NavMesh 烘焙参数无效 / invalid NavMesh build arguments");
        return 0;
    }
    output->data = nullptr;
    output->len = 0;
    try {
        float bounds_min[3];
        float bounds_max[3];
        rcCalcBounds(vertices, vertex_count, bounds_min, bounds_max);
        int grid_width = 0;
        int grid_height = 0;
        rcCalcGridSize(bounds_min, bounds_max, config->cell_size, &grid_width, &grid_height);
        const int tile_width = (grid_width + config->tile_size - 1) / config->tile_size;
        const int tile_height = (grid_height + config->tile_size - 1) / config->tile_size;
        rcChunkyTriMesh chunky_mesh;
        if (!rcCreateChunkyTriMesh(vertices, indices, triangle_count, 256, &chunky_mesh)) {
            set_error(error, error_capacity, "导航三角形空间索引创建失败 / failed to build navigation triangle index");
            return 0;
        }

        NavAssetData asset;
        rcContext context(false);
        const float tile_world_size = config->tile_size * config->cell_size;
        std::string build_error;
        for (int tile_y = 0; tile_y < tile_height; ++tile_y) {
            for (int tile_x = 0; tile_x < tile_width; ++tile_x) {
                float tile_min[3] = {
                    bounds_min[0] + tile_x * tile_world_size,
                    bounds_min[1],
                    bounds_min[2] + tile_y * tile_world_size,
                };
                float tile_max[3] = {
                    bounds_min[0] + (tile_x + 1) * tile_world_size,
                    bounds_max[1],
                    bounds_min[2] + (tile_y + 1) * tile_world_size,
                };
                if (!build_tile_layers(context, vertices, vertex_count, indices, triangle_count,
                                       chunky_mesh, *config, tile_x, tile_y, tile_min, tile_max,
                                       asset.layers, build_error)) {
                    set_error(error, error_capacity, build_error);
                    return 0;
                }
            }
        }
        if (asset.layers.empty()) {
            set_error(error, error_capacity, "Recast没有生成可行走高度层 / Recast produced no walkable layers");
            return 0;
        }

        const unsigned int layer_capacity = dtNextPow2(static_cast<unsigned int>(asset.layers.size()));
        const unsigned int tile_bits = std::min(dtIlog2(layer_capacity), 14u);
        const unsigned int poly_bits = 22u - tile_bits;
        rcVcopy(asset.nav.orig, bounds_min);
        asset.nav.tileWidth = config->tile_size * config->cell_size;
        asset.nav.tileHeight = config->tile_size * config->cell_size;
        asset.nav.maxTiles = 1 << tile_bits;
        asset.nav.maxPolys = 1 << poly_bits;
        rcVcopy(asset.cache.orig, bounds_min);
        asset.cache.cs = config->cell_size;
        asset.cache.ch = config->cell_height;
        asset.cache.width = config->tile_size;
        asset.cache.height = config->tile_size;
        asset.cache.walkableHeight = config->agent_height;
        asset.cache.walkableRadius = config->agent_radius;
        asset.cache.walkableClimb = config->agent_max_climb;
        asset.cache.maxSimplificationError = config->edge_max_error;
        asset.cache.maxTiles = asset.nav.maxTiles;
        asset.cache.maxObstacles = kMaxObstacles;

        std::vector<uint8_t> bytes;
        serialize_asset(asset, bytes);
        output->data = static_cast<uint8_t*>(std::malloc(bytes.size()));
        if (output->data == nullptr) {
            set_error(error, error_capacity, "NavMesh 输出内存分配失败 / failed to allocate NavMesh output");
            return 0;
        }
        std::memcpy(output->data, bytes.data(), bytes.size());
        output->len = bytes.size();
        return 1;
    } catch (const std::exception& exception) {
        set_error(error, error_capacity, exception.what());
        return 0;
    } catch (...) {
        set_error(error, error_capacity, "NavMesh 烘焙发生未知错误 / unknown NavMesh build failure");
        return 0;
    }
}

extern "C" void tz_navmesh_bytes_free(TzNavBytes bytes) {
    std::free(bytes.data);
}

extern "C" TzNavMesh* tz_navmesh_load(const uint8_t* data, size_t len, char* error, size_t error_capacity) {
    std::string load_error;
    NavAssetData asset;
    if (!deserialize_asset(data, len, asset, load_error)) {
        set_error(error, error_capacity, load_error);
        return nullptr;
    }
    TzNavMesh* result = new (std::nothrow) TzNavMesh();
    if (result == nullptr) {
        set_error(error, error_capacity, "NavMesh 句柄分配失败 / failed to allocate NavMesh handle");
        return nullptr;
    }
    result->asset = std::move(asset);
    return result;
}

extern "C" void tz_navmesh_free(TzNavMesh* mesh) {
    delete mesh;
}

extern "C" TzNavQuery* tz_navmesh_query_create(
    const TzNavMesh* mesh,
    char* error,
    size_t error_capacity) {
    if (mesh == nullptr || mesh->asset.layers.empty()) {
        set_error(error, error_capacity, "NavMesh资产无效 / invalid NavMesh asset");
        return nullptr;
    }
    TzNavQuery* result = new (std::nothrow) TzNavQuery();
    if (result == nullptr) {
        set_error(error, error_capacity, "NavMesh查询上下文分配失败 / failed to allocate NavMesh query context");
        return nullptr;
    }
    result->mesh = dtAllocNavMesh();
    result->tile_cache = dtAllocTileCache();
    result->query = dtAllocNavMeshQuery();
    if (result->mesh == nullptr || result->tile_cache == nullptr || result->query == nullptr ||
        dtStatusFailed(result->mesh->init(&mesh->asset.nav)) ||
        dtStatusFailed(result->tile_cache->init(&mesh->asset.cache, &result->allocator,
                                                &result->compressor, &result->mesh_process))) {
        delete result;
        set_error(error, error_capacity, "MapInstance动态NavMesh初始化失败 / failed to initialize instance NavMesh");
        return nullptr;
    }
    for (const CompressedLayer& source : mesh->asset.layers) {
        unsigned char* data = static_cast<unsigned char*>(dtAlloc(source.bytes.size(), DT_ALLOC_PERM));
        if (data == nullptr) {
            delete result;
            set_error(error, error_capacity, "TileCache高度层内存分配失败 / failed to allocate TileCache layer");
            return nullptr;
        }
        std::memcpy(data, source.bytes.data(), source.bytes.size());
        dtCompressedTileRef tile_ref = 0;
        if (dtStatusFailed(result->tile_cache->addTile(
                data, static_cast<int>(source.bytes.size()), DT_COMPRESSEDTILE_FREE_DATA, &tile_ref))) {
            dtFree(data);
            delete result;
            set_error(error, error_capacity, "MapInstance Tile装载失败 / failed to add instance TileCache layer");
            return nullptr;
        }
        if (dtStatusFailed(result->tile_cache->buildNavMeshTile(tile_ref, result->mesh))) {
            delete result;
            set_error(error, error_capacity, "MapInstance Tile构建失败 / failed to build instance NavMesh tile");
            return nullptr;
        }
    }
    if (dtStatusFailed(result->query->init(result->mesh, 4096))) {
        delete result;
        set_error(error, error_capacity, "NavMesh查询器初始化失败 / failed to initialize NavMesh query");
        return nullptr;
    }
    return result;
}

extern "C" void tz_navmesh_query_free(TzNavQuery* query) {
    delete query;
}

extern "C" int32_t tz_navmesh_project(
    const TzNavQuery* query,
    const float* point,
    const float* half_extents,
    float* projected) {
    if (query == nullptr || point == nullptr || half_extents == nullptr || projected == nullptr) return 0;
    dtQueryFilter filter;
    filter.setIncludeFlags(kWalkFlag);
    dtPolyRef reference = 0;
    const dtStatus status = query->query->findNearestPoly(point, half_extents, &filter, &reference, projected);
    return dtStatusSucceed(status) && reference != 0 ? 1 : 0;
}

extern "C" int32_t tz_navmesh_find_path(
    const TzNavQuery* query,
    const float* start,
    const float* end,
    const float* half_extents,
    float* points,
    int32_t max_points,
    int32_t* point_count) {
    if (query == nullptr || start == nullptr || end == nullptr || half_extents == nullptr ||
        points == nullptr || point_count == nullptr || max_points <= 0) return 0;
    dtQueryFilter filter;
    filter.setIncludeFlags(kWalkFlag);
    dtPolyRef start_ref = 0;
    dtPolyRef end_ref = 0;
    float nearest_start[3];
    float nearest_end[3];
    if (dtStatusFailed(query->query->findNearestPoly(start, half_extents, &filter, &start_ref, nearest_start)) ||
        dtStatusFailed(query->query->findNearestPoly(end, half_extents, &filter, &end_ref, nearest_end)) ||
        start_ref == 0 || end_ref == 0) return 0;

    std::vector<dtPolyRef> corridor(256);
    int corridor_count = 0;
    if (dtStatusFailed(query->query->findPath(start_ref, end_ref, nearest_start, nearest_end, &filter,
                                             corridor.data(), &corridor_count, static_cast<int>(corridor.size()))) ||
        corridor_count == 0) return 0;
    if (corridor[corridor_count - 1] != end_ref) {
        query->query->closestPointOnPoly(corridor[corridor_count - 1], nearest_end, nearest_end, nullptr);
    }
    std::vector<unsigned char> flags(static_cast<size_t>(max_points));
    int straight_count = 0;
    if (dtStatusFailed(query->query->findStraightPath(nearest_start, nearest_end, corridor.data(), corridor_count,
                                                     points, flags.data(), nullptr, &straight_count, max_points))) {
        return 0;
    }
    *point_count = straight_count;
    return straight_count > 0 ? 1 : 0;
}

extern "C" int32_t tz_navmesh_move_along_surface(
    const TzNavQuery* query,
    const float* start,
    const float* end,
    const float* half_extents,
    uint64_t start_ref_value,
    float* result,
    uint64_t* result_ref_value) {
    if (query == nullptr || start == nullptr || end == nullptr || half_extents == nullptr ||
        result == nullptr || result_ref_value == nullptr) return 0;
    dtQueryFilter filter;
    filter.setIncludeFlags(kWalkFlag);
    dtPolyRef start_ref = static_cast<dtPolyRef>(start_ref_value);
    float nearest_start[3] = {start[0], start[1], start[2]};
    if (start_ref == 0 || !query->query->isValidPolyRef(start_ref, &filter)) {
        if (dtStatusFailed(query->query->findNearestPoly(
                start, half_extents, &filter, &start_ref, nearest_start)) || start_ref == 0) {
            return 0;
        }
    }
    dtPolyRef visited[32];
    int visited_count = 0;
    if (dtStatusFailed(query->query->moveAlongSurface(
            start_ref, nearest_start, end, &filter, result, visited, &visited_count, 32))) {
        return 0;
    }
    const dtPolyRef result_ref = visited_count > 0 ? visited[visited_count - 1] : start_ref;
    float height = result[1];
    if (dtStatusSucceed(query->query->getPolyHeight(result_ref, result, &height))) {
        result[1] = height;
    }
    *result_ref_value = static_cast<uint64_t>(result_ref);
    return 1;
}

extern "C" int32_t tz_navmesh_raycast(
    const TzNavQuery* query,
    const float* start,
    const float* end,
    const float* half_extents,
    float* hit_t,
    float* hit_position,
    float* hit_normal) {
    if (query == nullptr || start == nullptr || end == nullptr || half_extents == nullptr ||
        hit_t == nullptr || hit_position == nullptr || hit_normal == nullptr) return 0;
    dtQueryFilter filter;
    filter.setIncludeFlags(kWalkFlag);
    dtPolyRef start_ref = 0;
    float nearest_start[3];
    if (dtStatusFailed(query->query->findNearestPoly(
            start, half_extents, &filter, &start_ref, nearest_start)) || start_ref == 0) return 0;
    dtPolyRef path[64];
    int path_count = 0;
    float t = 0.0f;
    if (dtStatusFailed(query->query->raycast(
            start_ref, nearest_start, end, &filter, &t, hit_normal, path, &path_count, 64))) return 0;
    const float clamped_t = std::min(1.0f, t);
    hit_position[0] = nearest_start[0] + (end[0] - nearest_start[0]) * clamped_t;
    hit_position[1] = nearest_start[1] + (end[1] - nearest_start[1]) * clamped_t;
    hit_position[2] = nearest_start[2] + (end[2] - nearest_start[2]) * clamped_t;
    if (path_count > 0) {
        float height = hit_position[1];
        if (dtStatusSucceed(query->query->getPolyHeight(path[path_count - 1], hit_position, &height))) {
            hit_position[1] = height;
        }
    }
    *hit_t = clamped_t;
    return 1;
}

extern "C" int32_t tz_navmesh_sample_height(
    const TzNavQuery* query,
    const float* point,
    const float* half_extents,
    float* height) {
    if (query == nullptr || point == nullptr || half_extents == nullptr || height == nullptr) return 0;
    dtQueryFilter filter;
    filter.setIncludeFlags(kWalkFlag);
    dtPolyRef reference = 0;
    float projected[3];
    if (dtStatusFailed(query->query->findNearestPoly(
            point, half_extents, &filter, &reference, projected)) || reference == 0) return 0;
    return dtStatusSucceed(query->query->getPolyHeight(reference, projected, height)) ? 1 : 0;
}

extern "C" int32_t tz_navmesh_obstacle_add_box(
    TzNavQuery* query,
    const float* center,
    const float* half_extents,
    float yaw_radians,
    uint64_t* obstacle_ref,
    char* error,
    size_t error_capacity) {
    if (query == nullptr || query->tile_cache == nullptr || center == nullptr ||
        half_extents == nullptr || obstacle_ref == nullptr ||
        half_extents[0] <= 0.0f || half_extents[1] <= 0.0f || half_extents[2] <= 0.0f) {
        set_error(error, error_capacity, "动态障碍参数无效 / invalid dynamic obstacle arguments");
        return 0;
    }
    dtObstacleRef reference = 0;
    const dtStatus status = query->tile_cache->addBoxObstacle(
        center, half_extents, yaw_radians, &reference);
    if (dtStatusFailed(status) || reference == 0) {
        set_error(error, error_capacity, "动态障碍队列已满或容量不足 / dynamic obstacle queue or capacity is full");
        return 0;
    }
    *obstacle_ref = static_cast<uint64_t>(reference);
    return 1;
}

extern "C" int32_t tz_navmesh_obstacle_remove(
    TzNavQuery* query,
    uint64_t obstacle_ref,
    char* error,
    size_t error_capacity) {
    if (query == nullptr || query->tile_cache == nullptr || obstacle_ref == 0) {
        set_error(error, error_capacity, "动态障碍引用无效 / invalid dynamic obstacle reference");
        return 0;
    }
    if (dtStatusFailed(query->tile_cache->removeObstacle(static_cast<dtObstacleRef>(obstacle_ref)))) {
        set_error(error, error_capacity, "动态障碍不存在或更新队列已满 / obstacle is missing or update queue is full");
        return 0;
    }
    return 1;
}

extern "C" int32_t tz_navmesh_obstacle_update(
    TzNavQuery* query,
    int32_t max_tile_updates,
    int32_t* processed_tile_updates,
    int32_t* up_to_date,
    char* error,
    size_t error_capacity) {
    if (query == nullptr || query->tile_cache == nullptr || max_tile_updates <= 0 ||
        processed_tile_updates == nullptr || up_to_date == nullptr) {
        set_error(error, error_capacity, "动态障碍更新参数无效 / invalid obstacle update arguments");
        return 0;
    }
    int processed = 0;
    bool current = false;
    while (processed < max_tile_updates && !current) {
        if (dtStatusFailed(query->tile_cache->update(0.0f, query->mesh, &current))) {
            set_error(error, error_capacity, "动态障碍Tile重建失败 / dynamic obstacle tile rebuild failed");
            return 0;
        }
        ++processed;
    }
    *processed_tile_updates = processed;
    *up_to_date = current ? 1 : 0;
    return 1;
}
