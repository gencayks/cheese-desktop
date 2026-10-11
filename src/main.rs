mod sidecar;

use std::env;

use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, Context, SharedString, Window, WindowBounds,
    WindowOptions,
};
use gpui_platform::application;

use sidecar::{MouseSettings, UsbDevice};

struct CheeseDesktop {
    heading: SharedString,
    status: SharedString,
    devices: Vec<UsbDevice>,
    list_error: Option<SharedString>,
    selected: Option<(u16, u16)>,
    settings: Option<MouseSettings>,
    settings_error: Option<SharedString>,
}

impl CheeseDesktop {
    fn supported(&self) -> Vec<&UsbDevice> {
        self.devices.iter().filter(|device| device.known).collect()
    }

    fn selected_device(&self) -> Option<&UsbDevice> {
        let (vid, pid) = self.selected?;
        self.devices
            .iter()
            .find(|device| device.vid == vid && device.pid == pid)
    }
}

fn device_row(device: &UsbDevice, selected: bool) -> impl IntoElement {
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap_1()
        .px_3()
        .py_2()
        .rounded_md()
        .bg(if selected {
            rgb(0x3a3a42)
        } else {
            rgb(0x2a2a2e)
        })
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

fn option_button(label: String, current: bool) -> impl IntoElement {
    div()
        .px_3()
        .py_1()
        .rounded_md()
        .text_sm()
        .text_color(rgb(0xffffff))
        .bg(if current {
            rgb(0x2e6e46)
        } else {
            rgb(0x3a3a3e)
        })
        .hover(|style| {
            style.bg(if current {
                rgb(0x2e6e46)
            } else {
                rgb(0x4a4a4e)
            })
        })
        .child(label)
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
                .children(supported.into_iter().map(|device| {
                    let vid = device.vid;
                    let pid = device.pid;
                    let selected = self.selected == Some((vid, pid));
                    div()
                        .id(("device", vid as u32 * 65536 + pid as u32))
                        .cursor_pointer()
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.select(Some((vid, pid)));
                            cx.notify();
                        }))
                        .child(device_row(device, selected))
                }))
        };
        let settings = self.settings_panel(cx);
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
            .child(settings)
    }
}

impl CheeseDesktop {
    fn settings_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(device) = self.selected_device() else {
            return div().text_sm().text_color(rgb(0xa0a0a8)).child("");
        };
        let vid = device.vid;
        let pid = device.pid;
        let title = sidecar::device_title(device);
        let error = self.settings_error.clone();
        let body =
            match &self.settings {
                None if error.is_none() => div()
                    .text_sm()
                    .text_color(rgb(0xa0a0a8))
                    .child("Reading settings…"),
                None => div().text_sm().text_color(rgb(0xe2686f)).child(
                    sidecar::friendly_settings_error(error.as_deref().unwrap_or("")),
                ),
                Some(settings) => {
                    let dpi = settings
                        .dpi
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "–".into());
                    let polling = settings
                        .polling_hz
                        .map(|value| format!("{value} Hz"))
                        .unwrap_or_else(|| "–".into());
                    let presets = sidecar::dpi_presets(settings.dpi_min, settings.dpi_max);
                    let rates = settings.polling_rates.clone();
                    let current_dpi = settings.dpi;
                    let current_rate = settings.polling_hz;
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(
                            div()
                                .text_sm()
                                .text_color(rgb(0xffffff))
                                .child(format!("DPI {dpi} · polling {polling}")),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(rgb(0xa0a0a8))
                                .child(sidecar::battery_line(settings)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .children(presets.into_iter().map(|preset| {
                                    let active = current_dpi == Some(preset);
                                    div()
                                        .id(("dpi", preset))
                                        .cursor_pointer()
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.apply(vid, pid, Some(preset), None);
                                            cx.notify();
                                        }))
                                        .child(option_button(preset.to_string(), active))
                                })),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .children(rates.into_iter().map(|rate| {
                                    let active = current_rate == Some(rate);
                                    div()
                                        .id(("polling", rate))
                                        .cursor_pointer()
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.apply(vid, pid, None, Some(rate));
                                            cx.notify();
                                        }))
                                        .child(option_button(format!("{rate} Hz"), active))
                                })),
                        )
                        .child(div().text_sm().text_color(rgb(0xe2686f)).child(
                            sidecar::friendly_settings_error(error.as_deref().unwrap_or("")),
                        ))
                }
            };
        div()
            .w_full()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0xa0a0a8))
                    .child(format!("{title} settings")),
            )
            .child(body)
    }

    fn script_path() -> Option<std::path::PathBuf> {
        let explicit = env::var("CHEESE_SIDECAR").ok();
        sidecar::locate_script(explicit.as_deref())
    }

    fn refresh_devices(&mut self) {
        match Self::script_path() {
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
        if self
            .selected_device()
            .filter(|device| device.known)
            .is_none()
        {
            let first = self
                .supported()
                .first()
                .map(|device| (device.vid, device.pid));
            self.select(first);
        }
    }

    fn select(&mut self, selected: Option<(u16, u16)>) {
        self.selected = selected;
        self.settings = None;
        self.settings_error = None;
        if let Some((vid, pid)) = selected {
            match Self::script_path() {
                None => self.settings_error = Some("Sidecar script not found".into()),
                Some(script) => match sidecar::mouse_status("node", &script, vid, pid) {
                    Ok(settings) => self.settings = Some(settings),
                    Err(error) => self.settings_error = Some(error.into()),
                },
            }
        }
    }

    fn apply(&mut self, vid: u16, pid: u16, dpi: Option<u32>, polling_hz: Option<u32>) {
        match Self::script_path() {
            None => self.settings_error = Some("Sidecar script not found".into()),
            Some(script) => match sidecar::mouse_set("node", &script, vid, pid, dpi, polling_hz) {
                Ok(settings) => {
                    self.settings = Some(settings);
                    self.settings_error = None;
                }
                Err(error) => self.settings_error = Some(error.into()),
            },
        }
    }
}

fn sidecar_status() -> SharedString {
    match CheeseDesktop::script_path() {
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
        let bounds = Bounds::centered(None, size(px(560.), px(620.)), cx);
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
                        selected: None,
                        settings: None,
                        settings_error: None,
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
