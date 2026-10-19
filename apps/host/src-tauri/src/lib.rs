#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("missing main window configuration")?;
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(is_allowed_navigation)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_devices, native_smoke_ready])
        .run(tauri::generate_context!())
        .expect("host app runtime failed");
}

fn is_allowed_navigation(url: &tauri::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("https", Some("tauri.localhost"), None) => true,
        ("http", Some("tauri.localhost"), None) => true,
        #[cfg(not(feature = "custom-protocol"))]
        ("http", Some("localhost"), Some(1420)) => true,
        _ => false,
    }
}

#[tauri::command]
fn list_devices() -> Vec<ais_host_core::device::DeviceSummary> {
    Vec::new()
}

#[tauri::command]
fn native_smoke_ready(app: tauri::AppHandle) -> Result<(), String> {
    if !std::env::args().any(|arg| arg == "--native-smoke") {
        return Err("Native smoke mode is not enabled.".to_string());
    }
    println!("AIS_HOST_READY");
    use std::io::Write;
    let _ = std::io::stdout().flush();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod navigation_tests {
    use super::is_allowed_navigation;
    use tauri::Url;

    #[test]
    fn accepts_only_app_origins() {
        for value in [
            "tauri://localhost/",
            "https://tauri.localhost/index.html",
            "http://tauri.localhost/index.html",
        ] {
            assert!(
                is_allowed_navigation(&Url::parse(value).expect("valid URL")),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_deceptive_hosts_credentials_and_ports() {
        for value in [
            "https://tauri.localhost.example.invalid/",
            "https://tauri.localhost:444/",
            "https://user@tauri.localhost/",
            "https://example.invalid/",
        ] {
            assert!(
                !is_allowed_navigation(&Url::parse(value).expect("valid URL")),
                "{value}"
            );
        }
    }
}
