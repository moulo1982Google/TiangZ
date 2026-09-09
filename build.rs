fn main() {
    println!("cargo:rerun-if-env-changed=TIANGZ_ENGINE_ROOT");
    println!("cargo:rerun-if-env-changed=TIANGZ_MODULE_NATIVE_BRIDGE");
    if let Some(root) = std::env::var_os("TIANGZ_ENGINE_ROOT") {
        std::env::set_current_dir(&root).expect("cannot enter TiangZ engine source root");
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&root).join("src").display()
        );
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&root).join("third_party").display()
        );
    }
    let bridge = if let Some(file) = std::env::var_os("TIANGZ_MODULE_NATIVE_BRIDGE") {
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&file).display()
        );
        std::fs::read_to_string(file).expect("cannot read module Native bridge")
    } else {
        "pub(crate) const FINGERPRINT: &str = \"\";\npub(crate) fn extensions() -> Vec<deno_core::Extension> { vec![] }\npub(crate) fn bootstraps() -> &'static [(&'static str, &'static str)] { &[] }\n".to_string()
    };
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR missing"));
    std::fs::write(output.join("module_native.rs"), bridge)
        .expect("cannot write module Native bridge");
    println!("cargo:rerun-if-changed=third_party/kcp/ikcp.c");
    println!("cargo:rerun-if-changed=third_party/kcp/ikcp.h");
    println!("cargo:rerun-if-changed=src/native/kcp_shim.c");

    println!("cargo:rerun-if-changed=third_party/recastnavigation/Recast/Include");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/Recast/Source");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/Detour/Include");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/Detour/Source");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/DetourTileCache/Include");
    println!("cargo:rerun-if-changed=third_party/recastnavigation/DetourTileCache/Source");
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
        .include("third_party/recastnavigation/DetourTileCache/Include")
        .include("third_party/recastnavigation/RecastDemo/Include")
        .file("third_party/recastnavigation/RecastDemo/Source/ChunkyTriMesh.cpp")
        .file("src/native/navmesh_shim.cpp");
    for source in glob_sources("third_party/recastnavigation/Recast/Source") {
        recast.file(source);
    }
    for source in glob_sources("third_party/recastnavigation/Detour/Source") {
        recast.file(source);
    }
    for source in glob_sources("third_party/recastnavigation/DetourTileCache/Source") {
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
