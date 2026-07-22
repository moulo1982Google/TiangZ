fn main() {
    println!("cargo:rerun-if-changed=third_party/kcp/ikcp.c");
    println!("cargo:rerun-if-changed=third_party/kcp/ikcp.h");
    println!("cargo:rerun-if-changed=src/native/kcp_shim.c");

    if std::env::var_os("CARGO_FEATURE_KCP").is_none() {
        return;
    }

    cc::Build::new()
        .file("third_party/kcp/ikcp.c")
        .file("src/native/kcp_shim.c")
        .include("third_party/kcp")
        .warnings(false)
        .compile("ikcp");
}
