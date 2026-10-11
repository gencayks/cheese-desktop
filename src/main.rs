mod sidecar;

use std::env;

use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, Context, SharedString, Window, WindowBounds,
    WindowOptions,
};
use gpui_platform::application;

use sidecar::UsbDevice;

struct CheeseDesktop {
    heading: SharedString,
    status: SharedString,
    devices: Vec<UsbDevice>,
    list_error: Option<SharedString>,
}

impl CheeseDesktop {
    fn supported(&self) -> Vec<&UsbDevice> {
        self.devices.iter().filter(|device| device.known).collect()
    }
}

fn device_row(device: &UsbDevice) -> impl IntoElement {
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap_1()
        .px_3()
        .py_2()
        .rounded_md()
        .bg(rgb(0x2a2a2e))
        .child(
            div()
                .text_color(rgb(0xffffff))
                .child(sidecar::device_title(device)),
        )
        .child(
            div()
                .text_sm()
                .text_color(rgb(0xa0a0a8))
                .child(sidecar::device_detail(device)),
        )
}

impl Render for CheeseDesktop {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let supported = self.supported();
        let list = if let Some(error) = &self.list_error {
            div()
                .text_sm()
                .text_color(rgb(0xe2686f))
                .child(error.clone())
        } else if supported.is_empty() {
            div()
                .text_sm()
                .text_color(rgb(0xa0a0a8))
                .child("No supported mice detected — connect one and press Refresh.")
        } else {
            div()
                .flex()
                .flex_col()
                .gap_2()
                .children(supported.into_iter().map(device_row))
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .bg(rgb(0x1c1c1e))
            .size_full()
            .justify_center()
            .items_center()
            .p_4()
            .text_xl()
            .text_color(rgb(0xffffff))
            .child(self.heading.clone())
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0xa0a0a8))
                    .child(self.status.clone()),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .text_sm()
                            .text_color(rgb(0xa0a0a8))
                            .child("Supported mice"),
                    )
                    .child(
                        div()
                            .id("refresh-devices")
                            .px_3()
                            .py_1()
                            .rounded_md()
                            .text_sm()
                            .text_color(rgb(0xffffff))
                            .bg(rgb(0x3a3a3e))
                            .hover(|style| style.bg(rgb(0x4a4a4e)))
                            .active(|style| style.bg(rgb(0x2a2a2e)))
                            .cursor_pointer()
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.refresh_devices();
                                cx.notify();
                            }))
                            .child("Refresh"),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .flex_1()
                    .id("device-list")
                    .overflow_y_scroll()
                    .child(list),
            )
    }
}

impl CheeseDesktop {
    fn refresh_devices(&mut self) {
        let explicit = env::var("CHEESE_SIDECAR").ok();
        match sidecar::locate_script(explicit.as_deref()) {
            None => {
                self.devices.clear();
                self.list_error = Some("Sidecar script not found (set CHEESE_SIDECAR)".into());
            }
            Some(script) => match sidecar::list_devices("node", &script) {
                Ok(devices) => {
                    self.devices = devices;
                    self.list_error = None;
                }
                Err(error) => {
                    self.devices.clear();
                    self.list_error = Some(error.into());
                }
            },
        }
    }
}

fn sidecar_status() -> SharedString {
    let explicit = env::var("CHEESE_SIDECAR").ok();
    match sidecar::locate_script(explicit.as_deref()) {
        None => "Sidecar: script not found (set CHEESE_SIDECAR)".into(),
        Some(script) => match sidecar::check_health("node", &script) {
            Ok(health) => format!(
                "Sidecar: {} · {} · {} filters",
                health.node, health.drivers, health.filters
            )
            .into(),
            Err(error) => format!("Sidecar: {error}").into(),
        },
    }
}

fn main() {
    let status = sidecar_status();
    application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(560.), px(520.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                app_id: Some("cheese-desktop".into()),
                ..Default::default()
            },
            |_, cx| {
                cx.new(|_| {
                    let mut view = CheeseDesktop {
                        heading: "Cheese Desktop".into(),
                        status: status.clone(),
                        devices: Vec::new(),
                        list_error: None,
                    };
                    view.refresh_devices();
                    view
                })
            },
        )
        .unwrap();
        cx.activate(true);
    });
}
