use ais_host_core::{
    create::ModelEntry,
    fetch::{FetchError, Http},
    model::{ModelError, model_url, obtain_model},
    release::{hex, sha256},
};
use std::{cell::Cell, io::Write};

struct Fake {
    body: Vec<u8>,
    requests: Cell<u32>,
}

impl Http for Fake {
    fn get(&self, url: &str, limit: u64, out: &mut dyn Write) -> Result<(), FetchError> {
        self.requests.set(self.requests.get() + 1);
        assert!(url.starts_with("https://huggingface.co/owner/name/resolve/"));
        if self.body.len() as u64 > limit {
            return Err(FetchError::Size);
        }
        out.write_all(&self.body).map_err(|_| FetchError::Network)
    }
}

fn entry(body: &[u8]) -> ModelEntry {
    ModelEntry {
        id: "synthetic".into(),
        name: "Synthetic".into(),
        quality: "fixture".into(),
        size_bytes: body.len() as u64,
        licence_name: "l".into(),
        licence_text: "t".into(),
        repository: "owner/name".into(),
        file: "synthetic.gguf".into(),
        revision: "b".repeat(40),
        sha256: hex(&sha256(body)),
    }
}

fn cache(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ais-model-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    path
}

#[test]
fn a_matching_download_is_kept_and_a_cache_hit_makes_no_request() {
    let body = b"SYNTHETIC_FIXTURE model bytes".to_vec();
    let entry = entry(&body);
    let dir = cache("ok");
    let http = Fake {
        body: body.clone(),
        requests: Cell::new(0),
    };
    let model = obtain_model(&http, &entry, &dir).unwrap();
    assert_eq!(model.file.metadata().unwrap().len(), body.len() as u64);
    assert_eq!(http.requests.get(), 1);
    obtain_model(&http, &entry, &dir).unwrap();
    assert_eq!(
        http.requests.get(),
        1,
        "cache is rechecked locally, not refetched"
    );
    assert!(model_url(&entry).contains(&"b".repeat(40)));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_wrong_digest_or_short_body_is_rejected_and_leaves_nothing_behind() {
    let good = b"SYNTHETIC_FIXTURE model bytes".to_vec();
    let entry = entry(&good);
    for (tag, body) in [
        ("digest", b"SYNTHETIC_FIXTURE model byteX".to_vec()),
        ("short", good[..5].to_vec()),
    ] {
        let dir = cache(tag);
        let http = Fake {
            body,
            requests: Cell::new(0),
        };
        assert!(matches!(
            obtain_model(&http, &entry, &dir),
            Err(ModelError::Pin)
        ));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn a_corrupted_cache_is_discarded_and_downloaded_again() {
    let body = b"SYNTHETIC_FIXTURE model bytes".to_vec();
    let entry = entry(&body);
    let dir = cache("stale");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&entry.file), b"tampered").unwrap();
    let http = Fake {
        body,
        requests: Cell::new(0),
    };
    obtain_model(&http, &entry, &dir).unwrap();
    assert_eq!(http.requests.get(), 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_model_larger_than_free_space_stops_before_any_request() {
    let mut entry = entry(b"x");
    entry.size_bytes = u64::MAX / 2;
    let dir = cache("space");
    let http = Fake {
        body: vec![],
        requests: Cell::new(0),
    };
    assert!(matches!(
        obtain_model(&http, &entry, &dir),
        Err(ModelError::Space)
    ));
    assert_eq!(http.requests.get(), 0);
    std::fs::remove_dir_all(&dir).unwrap();
}
