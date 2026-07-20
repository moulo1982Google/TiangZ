use std::net::{IpAddr, SocketAddr};

use anyhow::{Context, Result};
use deno_core::JsRuntime;
use deno_inspector_server::{InspectPublishUid, InspectorServer};

use crate::config::ProcessConfig;

pub struct ProcessInspector {
    _server: InspectorServer,
}

impl ProcessInspector {
    pub fn start(
        runtime: &mut JsRuntime,
        process: &ProcessConfig,
        module_url: String,
    ) -> Result<Option<Self>> {
        let Some(debug) = &process.debug else {
            return Ok(None);
        };
        let ip = debug
            .inspector_ip
            .parse::<IpAddr>()
            .with_context(|| format!("invalid inspector IP for {}", process.name))?;
        let server = InspectorServer::new(
            SocketAddr::new(ip, debug.inspector_port),
            "TiangZ",
            InspectPublishUid::default(),
        )
        .with_context(|| format!("{} failed to start inspector", process.name))?;
        let url = server.register_inspector(module_url, runtime.inspector(), debug.break_on_start);
        println!(
            "{} inspector listening on {} (breakOnStart={})",
            process.name, url.0, debug.break_on_start
        );

        if debug.break_on_start {
            println!(
                "{} waiting for debugger before executing TypeScript",
                process.name
            );
            runtime
                .inspector()
                .wait_for_session_and_break_on_next_statement();
        }

        Ok(Some(Self { _server: server }))
    }
}
