use std::path::PathBuf;

fn main() {
    // 编译 KCP 静态库
    cc::Build::new()
        .file("kcp/ikcp.c")
        .opt_level(3)
        .compile("libkcp.a");

    // 生成 Rust FFI 绑定
    let bindings = bindgen::Builder::default()
        .header("kcp/ikcp.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks))
        .generate()
        .expect("Failed to generate bindings");

    let out_path = PathBuf::from("src/ffi");
    bindings
        .write_to_file(out_path.join("kcp.rs"))
        .expect("Failed to write bindings");
}