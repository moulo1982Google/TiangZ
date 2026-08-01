//! 根据冷配置清单离线烘焙 NavMesh，并输出带 Hash 的元数据。 / Bakes NavMesh from a cold manifest and writes hash-bound metadata.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use anyhow::{Context, Result, bail};
use tiangz_transport::navigation::{
    NavAssetMetadata, NavBakeManifest, NavigationAsset, bake_obj, sha256_hex,
};

fn main() -> Result<()> {
    let manifest_path = parse_manifest_argument()?;
    let manifest_path = manifest_path.canonicalize().with_context(|| {
        format!(
            "导航烘焙清单不存在 / bake manifest does not exist: {}",
            manifest_path.display()
        )
    })?;
    let manifest_root = manifest_path.parent().context("导航烘焙清单没有父目录")?;
    let manifest: NavBakeManifest =
        serde_json::from_slice(&fs::read(&manifest_path).context("读取导航烘焙清单失败")?)
            .context("解析导航烘焙清单失败")?;
    validate_manifest(&manifest)?;

    let source = manifest_root.join(&manifest.source);
    let output = manifest_root.join(&manifest.output);
    let metadata_path = manifest_root.join(&manifest.metadata);
    let (bytes, seed) = bake_obj(&source, manifest.build)?;
    let hash = sha256_hex(&bytes);

    // 在落盘前立即回读 C++ 运行时格式，避免生成一个只能通过 Hash、却不能加载的资源。
    // Load the native runtime format before writing so a hash-valid but unreadable asset cannot be published.
    let asset = Rc::new(NavigationAsset::load(bytes.clone(), Some(&hash))?);
    asset
        .create_world()?
        .project([0.0, 1.0, 0.0], [4.0, 8.0, 4.0])
        .context("灰盒原点附近没有可行走面；请检查三角形绕序和烘焙参数")?;

    let metadata = NavAssetMetadata {
        format: "tiangz-navmesh".to_string(),
        format_version: 1,
        recast_version: "1.6.0".to_string(),
        map: manifest.map,
        navigation_version: manifest.navigation_version,
        navigation_hash: hash,
        source: manifest.source,
        vertex_count: seed.vertex_count,
        triangle_count: seed.triangle_count,
        bounds_min: seed.bounds_min,
        bounds_max: seed.bounds_max,
        build: manifest.build,
    };
    write_parent(&output, &bytes)?;
    write_parent(
        &metadata_path,
        &serde_json::to_vec_pretty(&metadata).context("序列化导航元数据失败")?,
    )?;
    println!(
        "[navmesh] map={} bytes={} triangles={} hash={}",
        metadata.map,
        bytes.len(),
        metadata.triangle_count,
        metadata.navigation_hash
    );
    println!("[navmesh] asset={}", output.display());
    println!("[navmesh] metadata={}", metadata_path.display());
    Ok(())
}

fn parse_manifest_argument() -> Result<PathBuf> {
    let mut args = env::args().skip(1);
    let mut manifest = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--manifest" => manifest = args.next().map(PathBuf::from),
            "--help" | "-h" => {
                println!("用法 / Usage: cargo run --bin navmesh_bake -- --manifest <bake.json>");
                std::process::exit(0);
            }
            _ => bail!("未知参数 / unknown argument: {argument}"),
        }
    }
    manifest.context("缺少 --manifest <bake.json>")
}

fn validate_manifest(manifest: &NavBakeManifest) -> Result<()> {
    if manifest.map.trim().is_empty() || manifest.navigation_version.trim().is_empty() {
        bail!("map 与 navigationVersion 不能为空");
    }
    if manifest.source.trim().is_empty()
        || manifest.output.trim().is_empty()
        || manifest.metadata.trim().is_empty()
    {
        bail!("source、output 与 metadata 不能为空");
    }
    Ok(())
}

fn write_parent(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建目录失败 / failed to create {}", parent.display()))?;
    }
    fs::write(path, bytes).with_context(|| format!("写入失败 / failed to write {}", path.display()))
}
