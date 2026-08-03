#include "navmesh_shim.h"

#include "ChunkyTriMesh.h"
#include "DetourCommon.h"
#include "DetourNavMesh.h"
#include "DetourNavMeshBuilder.h"
#include "DetourNavMeshQuery.h"
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

constexpr uint8_t kMagic[8] = {'T', 'Z', 'N', 'A', 'V', 'M', '0', '1'};
constexpr uint32_t kFormatVersion = 1;
constexpr unsigned short kWalkFlag = 1;

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
    rcContourSet* contours = nullptr;
    rcPolyMesh* poly_mesh = nullptr;
    rcPolyMeshDetail* detail_mesh = nullptr;

    ~TileBuildData() {
        rcFreeHeightField(solid);
        rcFreeCompactHeightfield(compact);
        rcFreeContourSet(contours);
        rcFreePolyMesh(poly_mesh);
        rcFreePolyMeshDetail(detail_mesh);
    }
};

bool build_tile(
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
    unsigned char** nav_data,
    int* nav_data_size,
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
    if (!rcErodeWalkableArea(&context, config.walkableRadius, *build.compact) ||
        !rcBuildDistanceField(&context, *build.compact) ||
        !rcBuildRegions(&context, *build.compact, config.borderSize, config.minRegionArea, config.mergeRegionArea)) {
        error = "无法生成可行走区域 / failed to build walkable regions";
        return false;
    }

    build.contours = rcAllocContourSet();
    if (build.contours == nullptr ||
        !rcBuildContours(&context, *build.compact, config.maxSimplificationError, config.maxEdgeLen, *build.contours)) {
        error = "无法生成导航轮廓 / failed to build navigation contours";
        return false;
    }
    if (build.contours->nconts == 0) return true;

    build.poly_mesh = rcAllocPolyMesh();
    if (build.poly_mesh == nullptr ||
        !rcBuildPolyMesh(&context, *build.contours, config.maxVertsPerPoly, *build.poly_mesh)) {
        error = "无法生成导航多边形 / failed to build navigation polygon mesh";
        return false;
    }
    build.detail_mesh = rcAllocPolyMeshDetail();
    if (build.detail_mesh == nullptr ||
        !rcBuildPolyMeshDetail(&context, *build.poly_mesh, *build.compact, config.detailSampleDist,
                               config.detailSampleMaxError, *build.detail_mesh)) {
        error = "无法生成导航细节网格 / failed to build navigation detail mesh";
        return false;
    }
    if (build.poly_mesh->nverts >= 0xffff || config.maxVertsPerPoly > DT_VERTS_PER_POLYGON) {
        error = "单个导航 Tile 的顶点或多边形顶点数超限 / navigation tile limits exceeded";
        return false;
    }

    for (int index = 0; index < build.poly_mesh->npolys; ++index) {
        if (build.poly_mesh->areas[index] == RC_WALKABLE_AREA) build.poly_mesh->areas[index] = 0;
        build.poly_mesh->flags[index] = kWalkFlag;
    }

    dtNavMeshCreateParams params{};
    params.verts = build.poly_mesh->verts;
    params.vertCount = build.poly_mesh->nverts;
    params.polys = build.poly_mesh->polys;
    params.polyAreas = build.poly_mesh->areas;
    params.polyFlags = build.poly_mesh->flags;
    params.polyCount = build.poly_mesh->npolys;
    params.nvp = build.poly_mesh->nvp;
    params.detailMeshes = build.detail_mesh->meshes;
    params.detailVerts = build.detail_mesh->verts;
    params.detailVertsCount = build.detail_mesh->nverts;
    params.detailTris = build.detail_mesh->tris;
    params.detailTriCount = build.detail_mesh->ntris;
    params.walkableHeight = input.agent_height;
    params.walkableRadius = input.agent_radius;
    params.walkableClimb = input.agent_max_climb;
    params.tileX = tile_x;
    params.tileY = tile_y;
    params.tileLayer = 0;
    rcVcopy(params.bmin, build.poly_mesh->bmin);
    rcVcopy(params.bmax, build.poly_mesh->bmax);
    params.cs = config.cs;
    params.ch = config.ch;
    params.buildBvTree = true;
    if (!dtCreateNavMeshData(&params, nav_data, nav_data_size)) {
        error = "Detour Tile 数据生成失败 / failed to create Detour tile data";
        return false;
    }
    return true;
}

bool serialize_mesh(const dtNavMesh& mesh, std::vector<uint8_t>& output) {
    output.insert(output.end(), std::begin(kMagic), std::end(kMagic));
    write_u32(output, kFormatVersion);
    uint32_t tile_count = 0;
    for (int index = 0; index < mesh.getMaxTiles(); ++index) {
        const dtMeshTile* tile = mesh.getTile(index);
        if (tile != nullptr && tile->header != nullptr && tile->dataSize > 0) ++tile_count;
    }
    write_u32(output, tile_count);
    const dtNavMeshParams* params = mesh.getParams();
    for (float value : params->orig) write_f32(output, value);
    write_f32(output, params->tileWidth);
    write_f32(output, params->tileHeight);
    write_u32(output, static_cast<uint32_t>(params->maxTiles));
    write_u32(output, static_cast<uint32_t>(params->maxPolys));
    for (int index = 0; index < mesh.getMaxTiles(); ++index) {
        const dtMeshTile* tile = mesh.getTile(index);
        if (tile == nullptr || tile->header == nullptr || tile->dataSize <= 0) continue;
        write_u64(output, static_cast<uint64_t>(mesh.getTileRef(tile)));
        write_u32(output, static_cast<uint32_t>(tile->dataSize));
        output.insert(output.end(), tile->data, tile->data + tile->dataSize);
    }
    return true;
}

dtNavMesh* deserialize_mesh(const uint8_t* data, size_t len, std::string& error) {
    if (data == nullptr || len < sizeof(kMagic) || std::memcmp(data, kMagic, sizeof(kMagic)) != 0) {
        error = "不是 TiangZ NavMesh 资源 / invalid TiangZ NavMesh magic";
        return nullptr;
    }
    const uint8_t* cursor = data + sizeof(kMagic);
    const uint8_t* end = data + len;
    uint32_t version = 0;
    uint32_t tile_count = 0;
    dtNavMeshParams params{};
    uint32_t max_tiles = 0;
    uint32_t max_polys = 0;
    if (!read_u32(cursor, end, version) || version != kFormatVersion ||
        !read_u32(cursor, end, tile_count) ||
        !read_f32(cursor, end, params.orig[0]) || !read_f32(cursor, end, params.orig[1]) ||
        !read_f32(cursor, end, params.orig[2]) || !read_f32(cursor, end, params.tileWidth) ||
        !read_f32(cursor, end, params.tileHeight) || !read_u32(cursor, end, max_tiles) ||
        !read_u32(cursor, end, max_polys)) {
        error = "NavMesh 资源头损坏或版本不支持 / corrupt or unsupported NavMesh header";
        return nullptr;
    }
    if (tile_count > max_tiles || max_tiles == 0 || max_polys == 0) {
        error = "NavMesh 资源容量字段无效 / invalid NavMesh capacity";
        return nullptr;
    }
    params.maxTiles = static_cast<int>(max_tiles);
    params.maxPolys = static_cast<int>(max_polys);
    dtNavMesh* mesh = dtAllocNavMesh();
    if (mesh == nullptr || dtStatusFailed(mesh->init(&params))) {
        dtFreeNavMesh(mesh);
        error = "无法初始化 Detour NavMesh / failed to initialize Detour NavMesh";
        return nullptr;
    }
    for (uint32_t index = 0; index < tile_count; ++index) {
        uint64_t tile_ref = 0;
        uint32_t data_size = 0;
        if (!read_u64(cursor, end, tile_ref) || !read_u32(cursor, end, data_size) ||
            data_size == 0 || static_cast<size_t>(end - cursor) < data_size) {
            dtFreeNavMesh(mesh);
            error = "NavMesh Tile 数据不完整 / truncated NavMesh tile";
            return nullptr;
        }
        unsigned char* tile_data = static_cast<unsigned char*>(dtAlloc(data_size, DT_ALLOC_PERM));
        if (tile_data == nullptr) {
            dtFreeNavMesh(mesh);
            error = "NavMesh Tile 内存分配失败 / failed to allocate NavMesh tile";
            return nullptr;
        }
        std::memcpy(tile_data, cursor, data_size);
        cursor += data_size;
        if (dtStatusFailed(mesh->addTile(tile_data, static_cast<int>(data_size), DT_TILE_FREE_DATA,
                                         static_cast<dtTileRef>(tile_ref), nullptr))) {
            dtFree(tile_data);
            dtFreeNavMesh(mesh);
            error = "NavMesh Tile 加载失败 / failed to load NavMesh tile";
            return nullptr;
        }
    }
    if (cursor != end) {
        dtFreeNavMesh(mesh);
        error = "NavMesh 资源含有未知尾部数据 / unexpected trailing NavMesh data";
        return nullptr;
    }
    return mesh;
}

}  // namespace

struct TzNavMesh {
    dtNavMesh* mesh = nullptr;

    ~TzNavMesh() {
        dtFreeNavMesh(mesh);
    }
};

struct TzNavQuery {
    const TzNavMesh* asset = nullptr;
    dtNavMeshQuery* query = nullptr;

    ~TzNavQuery() {
        dtFreeNavMeshQuery(query);
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
        const unsigned int desired_tiles = static_cast<unsigned int>(std::max(1, tile_width * tile_height));
        const unsigned int tile_bits = std::min(dtIlog2(dtNextPow2(desired_tiles)), 14u);
        const unsigned int poly_bits = 22u - tile_bits;
        rcChunkyTriMesh chunky_mesh;
        if (!rcCreateChunkyTriMesh(vertices, indices, triangle_count, 256, &chunky_mesh)) {
            set_error(error, error_capacity, "导航三角形空间索引创建失败 / failed to build navigation triangle index");
            return 0;
        }

        dtNavMeshParams params{};
        rcVcopy(params.orig, bounds_min);
        params.tileWidth = config->tile_size * config->cell_size;
        params.tileHeight = config->tile_size * config->cell_size;
        params.maxTiles = 1 << tile_bits;
        params.maxPolys = 1 << poly_bits;
        dtNavMesh* mesh = dtAllocNavMesh();
        if (mesh == nullptr || dtStatusFailed(mesh->init(&params))) {
            dtFreeNavMesh(mesh);
            set_error(error, error_capacity, "无法初始化 Detour Tile 容器 / failed to initialize tiled Detour mesh");
            return 0;
        }

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
                unsigned char* tile_data = nullptr;
                int tile_data_size = 0;
                if (!build_tile(context, vertices, vertex_count, indices, triangle_count, chunky_mesh,
                                *config, tile_x, tile_y, tile_min, tile_max, &tile_data,
                                &tile_data_size, build_error)) {
                    dtFreeNavMesh(mesh);
                    set_error(error, error_capacity, build_error);
                    return 0;
                }
                if (tile_data != nullptr &&
                    dtStatusFailed(mesh->addTile(tile_data, tile_data_size, DT_TILE_FREE_DATA, 0, nullptr))) {
                    dtFree(tile_data);
                    dtFreeNavMesh(mesh);
                    set_error(error, error_capacity, "Detour Tile 装载失败 / failed to add Detour tile");
                    return 0;
                }
            }
        }

        std::vector<uint8_t> bytes;
        serialize_mesh(*mesh, bytes);
        dtFreeNavMesh(mesh);
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
    dtNavMesh* mesh = deserialize_mesh(data, len, load_error);
    if (mesh == nullptr) {
        set_error(error, error_capacity, load_error);
        return nullptr;
    }
    TzNavMesh* result = new (std::nothrow) TzNavMesh();
    if (result == nullptr) {
        dtFreeNavMesh(mesh);
        set_error(error, error_capacity, "NavMesh 句柄分配失败 / failed to allocate NavMesh handle");
        return nullptr;
    }
    result->mesh = mesh;
    return result;
}

extern "C" void tz_navmesh_free(TzNavMesh* mesh) {
    delete mesh;
}

extern "C" TzNavQuery* tz_navmesh_query_create(
    const TzNavMesh* mesh,
    char* error,
    size_t error_capacity) {
    if (mesh == nullptr || mesh->mesh == nullptr) {
        set_error(error, error_capacity, "NavMesh资产无效 / invalid NavMesh asset");
        return nullptr;
    }
    TzNavQuery* result = new (std::nothrow) TzNavQuery();
    if (result == nullptr) {
        set_error(error, error_capacity, "NavMesh查询上下文分配失败 / failed to allocate NavMesh query context");
        return nullptr;
    }
    result->asset = mesh;
    result->query = dtAllocNavMeshQuery();
    if (result->query == nullptr || dtStatusFailed(result->query->init(mesh->mesh, 4096))) {
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
