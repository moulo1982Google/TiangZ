use std::collections::HashSet;
use std::env;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use anyhow::{Context, Result, bail};

use crate::config::StartMachineConfig;

pub async fn run_start_machine(root: &Path, start_machine_path: PathBuf) -> Result<()> {
    let config_text = std::fs::read_to_string(&start_machine_path)
        .with_context(|| format!("failed to read {}", start_machine_path.display()))?;
    let start_machine: StartMachineConfig = serde_json::from_str(&config_text)
        .with_context(|| format!("failed to parse {}", start_machine_path.display()))?;

    let local_ips = get_local_ips();
    println!(
        "start machine from {}, local ips: {}",
        start_machine_path.display(),
        local_ips.iter().cloned().collect::<Vec<_>>().join(", ")
    );

    let start_dir = start_machine_path
        .parent()
        .context("StartMachine.json has no parent directory")?;
    let mut processes = Vec::<PathBuf>::new();
    for machine in &start_machine.machines {
        if !is_this_machine(&machine.inner_ip, &local_ips) {
            continue;
        }

        println!(
            "matched machine {} ({})",
            machine.name.as_deref().unwrap_or("<unnamed>"),
            machine.inner_ip
        );
        for process in &machine.processes {
            let path = PathBuf::from(process);
            let resolved = if path.is_absolute() {
                path
            } else {
                start_dir.join(path)
            };
            processes.push(resolved);
        }
    }

    if processes.is_empty() {
        bail!(
            "not found this machine ip config in {}; local ips: {}",
            start_machine_path.display(),
            local_ips.iter().cloned().collect::<Vec<_>>().join(", ")
        );
    }

    let exe = env::current_exe().context("failed to get current executable")?;
    let mut children = Vec::<Child>::new();
    for process_config in processes {
        let arg = to_process_arg(root, &process_config);
        println!("starting process config {}", arg.display());
        let child = Command::new(&exe)
            .arg(&arg)
            .current_dir(root)
            .spawn()
            .with_context(|| format!("failed to start {}", arg.display()))?;
        children.push(child);
    }

    tokio::signal::ctrl_c().await?;
    println!("stopping {} child process(es)", children.len());
    for child in &mut children {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn to_process_arg(root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(root).unwrap_or(path).to_path_buf()
}

fn is_this_machine(ip: &str, local_ips: &HashSet<String>) -> bool {
    ip == "127.0.0.1" || ip == "0.0.0.0" || local_ips.contains(ip)
}

fn get_local_ips() -> HashSet<String> {
    let mut ips = HashSet::new();
    ips.insert("127.0.0.1".to_string());

    if let Ok(value) = env::var("ETS_MACHINE_IP") {
        for item in value.split([',', ';', ' ']) {
            add_ip_token(&mut ips, item);
        }
    }

    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                ips.insert(addr.ip().to_string());
            }
        }
    }

    collect_command_ips(&mut ips, "hostname", &["-I"]);
    if cfg!(windows) {
        collect_command_ips(&mut ips, "ipconfig", &[]);
    } else {
        collect_command_ips(&mut ips, "ip", &["-o", "-4", "addr", "show"]);
    }

    ips
}

fn collect_command_ips(ips: &mut HashSet<String>, program: &str, args: &[&str]) {
    let Ok(output) = Command::new(program).args(args).output() else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for token in text.split_whitespace() {
        add_ip_token(ips, token);
    }
}

fn add_ip_token(ips: &mut HashSet<String>, token: &str) {
    let token = token
        .trim_matches(|ch: char| !ch.is_ascii_hexdigit() && ch != '.' && ch != ':')
        .split('/')
        .next()
        .unwrap_or("");
    if token.parse::<std::net::IpAddr>().is_ok() {
        ips.insert(token.to_string());
    }
}
