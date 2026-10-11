mod sidecar;

use std::env;

use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, Context, SharedString, Window, WindowBounds,
    WindowOptions,
};
use gpui_platform::application;

struct CheeseDesktop {
    heading: SharedString,
    status: SharedString,
}

impl Render for CheeseDesktop {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .bg(rgb(0x1c1c1e))
            .size(px(520.0))
            .justify_center()
            .items_center()
            .text_xl()
            .text_color(rgb(0xffffff))
            .child(self.heading.clone())
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0xa0a0a8))
                    .child(self.status.clone()),
            )
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
        let bounds = Bounds::centered(None, size(px(520.), px(320.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                app_id: Some("cheese-desktop".into()),
                ..Default::default()
            },
            |_, cx| {
                cx.new(|_| CheeseDesktop {
                    heading: "Cheese Desktop".into(),
                    status: status.clone(),
                })
            },
        )
        .unwrap();
        cx.activate(true);
    });
}
