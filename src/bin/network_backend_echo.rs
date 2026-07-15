#[path = "../allocator.rs"]
mod allocator;

#[cfg(all(target_os = "linux", feature = "io-uring"))]
mod linux {
    use std::env;
    use std::io;
    use std::net::SocketAddr;

    use anyhow::{Context, Result, bail};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener as TokioTcpListener, TcpStream as TokioTcpStream};
    use tokio_uring::buf::{BoundedBuf, Slice};
    use tokio_uring::net::{TcpListener as UringTcpListener, TcpStream as UringTcpStream};

    const MAX_FRAME_LEN: usize = 1024 * 1024;
    const REQUEST_MSGCODE: u16 = 15_002;
    const RESPONSE_MSGCODE: u16 = 15_003;

    #[derive(Clone, Copy, Debug)]
    enum Backend {
        Epoll,
        IoUring,
    }

    struct Options {
        backend: Backend,
        address: SocketAddr,
        uring_entries: u32,
        workers: usize,
    }

    pub fn main() -> Result<()> {
        let options = parse_options()?;
        match options.backend {
            Backend::Epoll => run_epoll(options.address, options.workers),
            Backend::IoUring => {
                run_io_uring(options.address, options.uring_entries, options.workers)
            }
        }
    }

    fn run_epoll(address: SocketAddr, workers: usize) -> Result<()> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(workers)
            .enable_all()
            .build()
            .context("failed to create Tokio epoll runtime")?;
        runtime.block_on(async move {
            let listener = TokioTcpListener::bind(address).await?;
            println!(
                "network-backend-ready backend=epoll address={} workers={workers}",
                listener.local_addr()?
            );
            loop {
                let (stream, _) = listener.accept().await?;
                tokio::spawn(async move {
                    if let Err(error) = handle_epoll_connection(stream).await {
                        eprintln!("epoll connection closed: {error}");
                    }
                });
            }
            #[allow(unreachable_code)]
            Result::<()>::Ok(())
        })
    }

    async fn handle_epoll_connection(mut stream: TokioTcpStream) -> io::Result<()> {
        stream.set_nodelay(true)?;
        loop {
            let length = match stream.read_u32().await {
                Ok(length) => length as usize,
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(error) => return Err(error),
            };
            validate_length(length)?;

            let mut frame = vec![0_u8; length];
            stream.read_exact(&mut frame).await?;
            make_response(&mut frame)?;

            let mut packet = Vec::with_capacity(4 + frame.len());
            packet.extend_from_slice(&(length as u32).to_be_bytes());
            packet.extend_from_slice(&frame);
            stream.write_all(&packet).await?;
        }
    }

    fn run_io_uring(address: SocketAddr, entries: u32, workers: usize) -> Result<()> {
        let listener = std::net::TcpListener::bind(address)?;
        let address = listener.local_addr()?;
        let mut threads = Vec::with_capacity(workers);
        for worker_index in 0..workers {
            let listener = listener.try_clone()?;
            threads.push(std::thread::spawn(move || {
                let mut builder = tokio_uring::builder();
                builder.entries(entries);
                builder.start(async move {
                    let listener = UringTcpListener::from_std(listener);
                    if worker_index == 0 {
                        println!(
                            "network-backend-ready backend=io-uring address={address} entries={entries} workers={workers}"
                        );
                    }
                    loop {
                        let (stream, _) = listener.accept().await?;
                        tokio_uring::spawn(async move {
                            if let Err(error) = handle_io_uring_connection(stream).await {
                                eprintln!("io_uring connection closed: {error}");
                            }
                        });
                    }
                    #[allow(unreachable_code)]
                    Result::<()>::Ok(())
                })
            }));
        }

        for thread in threads {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("io_uring worker thread panicked"))??;
        }
        Ok(())
    }

    async fn handle_io_uring_connection(stream: UringTcpStream) -> io::Result<()> {
        stream.set_nodelay(true)?;
        loop {
            let prefix = match uring_read_exact(&stream, vec![0_u8; 4]).await {
                Ok(prefix) => prefix,
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(error) => return Err(error),
            };
            let length = u32::from_be_bytes(prefix.as_slice().try_into().unwrap()) as usize;
            validate_length(length)?;

            let mut frame = uring_read_exact(&stream, vec![0_u8; length]).await?;
            make_response(&mut frame)?;

            let mut packet = Vec::with_capacity(4 + frame.len());
            packet.extend_from_slice(&(length as u32).to_be_bytes());
            packet.extend_from_slice(&frame);
            let (result, _) = stream.write_all(packet).await;
            result?;
        }
    }

    async fn uring_read_exact(stream: &UringTcpStream, buffer: Vec<u8>) -> io::Result<Vec<u8>> {
        let mut slice: Slice<Vec<u8>> = buffer.slice(..);
        while slice.bytes_total() != 0 {
            let (result, returned) = stream.read(slice).await;
            match result {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "connection closed while reading frame",
                    ));
                }
                Ok(read) => slice = returned.slice(read..),
                Err(error) => return Err(error),
            }
        }
        Ok(slice.into_inner())
    }

    fn validate_length(length: usize) -> io::Result<()> {
        if (2..=MAX_FRAME_LEN).contains(&length) {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid frame length: {length}"),
            ))
        }
    }

    fn make_response(frame: &mut [u8]) -> io::Result<()> {
        let msgcode = u16::from_be_bytes([frame[0], frame[1]]);
        if msgcode != REQUEST_MSGCODE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected request msgcode: {msgcode}"),
            ));
        }
        frame[..2].copy_from_slice(&RESPONSE_MSGCODE.to_be_bytes());
        Ok(())
    }

    fn parse_options() -> Result<Options> {
        let mut backend = None;
        let mut host = "127.0.0.1".to_string();
        let mut port = 7410_u16;
        let mut uring_entries = 1024_u32;
        let mut workers = 4_usize;
        let mut args = env::args().skip(1);

        while let Some(name) = args.next() {
            let value = args
                .next()
                .with_context(|| format!("{name} requires a value"))?;
            match name.as_str() {
                "--backend" => {
                    backend = Some(match value.as_str() {
                        "epoll" => Backend::Epoll,
                        "io-uring" => Backend::IoUring,
                        _ => bail!("--backend must be epoll or io-uring"),
                    });
                }
                "--host" => host = value,
                "--port" => port = value.parse().context("invalid --port")?,
                "--uring-entries" => {
                    uring_entries = value.parse().context("invalid --uring-entries")?;
                    if !uring_entries.is_power_of_two() {
                        bail!("--uring-entries must be a power of two");
                    }
                }
                "--workers" => {
                    workers = value.parse().context("invalid --workers")?;
                    if workers == 0 {
                        bail!("--workers must be greater than zero");
                    }
                }
                _ => bail!("unknown argument: {name}"),
            }
        }

        let backend = backend.context("--backend is required")?;
        let address = format!("{host}:{port}")
            .parse()
            .context("invalid listen address")?;
        Ok(Options {
            backend,
            address,
            uring_entries,
            workers,
        })
    }
}

#[cfg(all(target_os = "linux", feature = "io-uring"))]
fn main() -> anyhow::Result<()> {
    linux::main()
}

#[cfg(not(all(target_os = "linux", feature = "io-uring")))]
fn main() {
    eprintln!("network_backend_echo requires Linux and --features io-uring");
    std::process::exit(2);
}
