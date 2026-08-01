fn main() {
    println!("cargo:rerun-if-changed=third_party/kcp/ikcp.c");
    println!("cargo:rerun-if-changed=third_party/kcp/ikcp.h");
    println!("cargo:rerun-if-changed=src/native/kcp_shim.c");

    println!("cargo:rerun-if-changed=third_party/recastnavigation/Recast/Include");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/Recast/Source");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/Detour/Include");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/Detour/Source");
    println!(
        "cargo:rerun-if-changed=third_party/recastnavigation/RecastDemo/Include/ChunkyTriMesh.h"
    );
    println!(
        "cargo:rerun-if-changed=third_party/recastnavigation/RecastDemo/Source/ChunkyTriMesh.cpp"
    );
    println!("cargo:rerun-if-changed=src/native/navmesh_shim.cpp");
    println!("cargo:rerun-if-changed=src/native/navmesh_shim.h");

    if std::env::var_os("CARGO_FEATURE_KCP").is_some() {
        cc::Build::new()
            .file("third_party/kcp/ikcp.c")
            .file("src/native/kcp_shim.c")
            .include("third_party/kcp")
            .warnings(false)
            .compile("ikcp");
    }

    let mut recast = cc::Build::new();
    recast
        .cpp(true)
        .std("c++17")
        .include("third_party/recastnavigation/Recast/Include")
        .include("third_party/recastnavigation/Detour/Include")
        .include("third_party/recastnavigation/RecastDemo/Include")
        .file("third_party/recastnavigation/RecastDemo/Source/ChunkyTriMesh.cpp")
        .file("src/native/navmesh_shim.cpp");
    for source in glob_sources("third_party/recastnavigation/Recast/Source") {
        recast.file(source);
    }
    for source in glob_sources("third_party/recastnavigation/Detour/Source") {
        recast.file(source);
    }
    recast.warnings(false).compile("tiangz_recast");
}

fn glob_sources(directory: &str) -> Vec<std::path::PathBuf> {
    let mut sources = std::fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("failed to read {directory}: {error}"))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "cpp"))
        .collect::<Vec<_>>();
    sources.sort();
    sources
}
