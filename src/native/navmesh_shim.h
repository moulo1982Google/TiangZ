#ifndef TIANGZ_NAVMESH_SHIM_H
#define TIANGZ_NAVMESH_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TzNavBuildConfig {
    float cell_size;
    float cell_height;
    float agent_height;
    float agent_radius;
    float agent_max_climb;
    float agent_max_slope;
    float region_min_size;
    float region_merge_size;
    float edge_max_len;
    float edge_max_error;
    float detail_sample_dist;
    float detail_sample_max_error;
    int32_t verts_per_poly;
    int32_t tile_size;
} TzNavBuildConfig;

typedef struct TzNavBytes {
    uint8_t* data;
    size_t len;
} TzNavBytes;

typedef struct TzNavMesh TzNavMesh;
typedef struct TzNavQuery TzNavQuery;

int32_t tz_navmesh_build(
    const float* vertices,
    int32_t vertex_count,
    const int32_t* indices,
    int32_t triangle_count,
    const TzNavBuildConfig* config,
    TzNavBytes* output,
    char* error,
    size_t error_capacity);

void tz_navmesh_bytes_free(TzNavBytes bytes);

TzNavMesh* tz_navmesh_load(
    const uint8_t* data,
    size_t len,
    char* error,
    size_t error_capacity);

void tz_navmesh_free(TzNavMesh* mesh);

TzNavQuery* tz_navmesh_query_create(
    const TzNavMesh* mesh,
    char* error,
    size_t error_capacity);

void tz_navmesh_query_free(TzNavQuery* query);

int32_t tz_navmesh_project(
    const TzNavQuery* query,
    const float* point,
    const float* half_extents,
    float* projected);

int32_t tz_navmesh_find_path(
    const TzNavQuery* query,
    const float* start,
    const float* end,
    const float* half_extents,
    float* points,
    int32_t max_points,
    int32_t* point_count);

int32_t tz_navmesh_move_along_surface(
    const TzNavQuery* query,
    const float* start,
    const float* end,
    const float* half_extents,
    uint64_t start_ref,
    float* result,
    uint64_t* result_ref);

int32_t tz_navmesh_raycast(
    const TzNavQuery* query,
    const float* start,
    const float* end,
    const float* half_extents,
    float* hit_t,
    float* hit_position,
    float* hit_normal);

int32_t tz_navmesh_sample_height(
    const TzNavQuery* query,
    const float* point,
    const float* half_extents,
    float* height);

int32_t tz_navmesh_obstacle_add_box(
    TzNavQuery* query,
    const float* center,
    const float* half_extents,
    float yaw_radians,
    uint64_t* obstacle_ref,
    char* error,
    size_t error_capacity);

int32_t tz_navmesh_obstacle_remove(
    TzNavQuery* query,
    uint64_t obstacle_ref,
    char* error,
    size_t error_capacity);

int32_t tz_navmesh_obstacle_update(
    TzNavQuery* query,
    int32_t max_tile_updates,
    int32_t* processed_tile_updates,
    int32_t* up_to_date,
    char* error,
    size_t error_capacity);

#ifdef __cplusplus
}
#endif

#endif
