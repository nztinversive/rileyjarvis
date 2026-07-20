import AVFoundation
import Capacitor
import UIKit

@objc(VectorAudioSessionPlugin)
public final class VectorAudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    private enum MicrophonePermission {
        case granted
        case denied
        case undetermined
        case restricted
    }

    public let identifier = "VectorAudioSessionPlugin"
    public let jsName = "VectorAudioSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deactivate", returnType: CAPPluginReturnPromise)
    ]

    private let audioSession = AVAudioSession.sharedInstance()
    private var observers: [NSObjectProtocol] = []
    private var isPreparing = false
    private var preparationGeneration = 0

    public override func load() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: audioSession,
                queue: .main
            ) { [weak self] notification in
                self?.handleInterruption(notification)
            },
            center.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: audioSession,
                queue: .main
            ) { [weak self] notification in
                self?.handleRouteChange(notification)
            },
            center.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification,
                object: audioSession,
                queue: .main
            ) { [weak self] _ in
                self?.cancelPreparation()
                self?.emit(
                    type: "media-services-reset",
                    shouldDisconnect: true
                )
            },
            center.addObserver(
                forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.deactivateWithoutCallback()
                self?.emit(
                    type: "protected-data-unavailable",
                    shouldDisconnect: true
                )
            },
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.deactivateWithoutCallback()
            }
        ]
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    @objc public func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("The audio session is unavailable.", "AUDIO_SESSION_UNAVAILABLE")
                return
            }
            guard !self.isPreparing else {
                call.reject(
                    "Microphone preparation is already in progress.",
                    "AUDIO_SESSION_PREPARE_IN_PROGRESS"
                )
                return
            }
            self.isPreparing = true
            self.preparationGeneration += 1
            self.requestPermissionAndActivate(
                call,
                generation: self.preparationGeneration
            )
        }
    }

    @objc public func deactivate(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.cancelPreparation()
            do {
                try self.audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                call.resolve()
            } catch {
                call.reject(
                    "The audio session could not be deactivated.",
                    "AUDIO_SESSION_DEACTIVATION_FAILED"
                )
            }
        }
    }

    private func requestPermissionAndActivate(
        _ call: CAPPluginCall,
        generation: Int
    ) {
        switch microphonePermission {
        case .granted:
            activate(call, generation: generation)
        case .denied:
            isPreparing = false
            call.reject(
                "Microphone access is denied. Enable it for Vector in Settings.",
                "MICROPHONE_PERMISSION_DENIED"
            )
        case .undetermined:
            requestRecordPermission { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else {
                        call.reject(
                            "The audio session is unavailable.",
                            "AUDIO_SESSION_UNAVAILABLE"
                        )
                        return
                    }
                    guard self.isPreparing,
                          generation == self.preparationGeneration else {
                        call.reject(
                            "Microphone preparation was cancelled.",
                            "AUDIO_SESSION_PREPARE_CANCELLED"
                        )
                        return
                    }
                    guard granted else {
                        self.isPreparing = false
                        call.reject(
                            "Microphone access was not granted. Enable it for Vector in Settings.",
                            "MICROPHONE_PERMISSION_DENIED"
                        )
                        return
                    }
                    self.activate(call, generation: generation)
                }
            }
        case .restricted:
            isPreparing = false
            call.reject(
                "Microphone permission is restricted on this device.",
                "MICROPHONE_PERMISSION_RESTRICTED"
            )
        }
    }

    private var microphonePermission: MicrophonePermission {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted:
                return .granted
            case .denied:
                return .denied
            case .undetermined:
                return .undetermined
            @unknown default:
                return .restricted
            }
        }

        switch audioSession.recordPermission {
        case .granted:
            return .granted
        case .denied:
            return .denied
        case .undetermined:
            return .undetermined
        @unknown default:
            return .restricted
        }
    }

    private func requestRecordPermission(_ completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
            audioSession.requestRecordPermission(completion)
        }
    }

    private func activate(_ call: CAPPluginCall, generation: Int) {
        guard isPreparing, generation == preparationGeneration else {
            call.reject(
                "Microphone preparation was cancelled.",
                "AUDIO_SESSION_PREPARE_CANCELLED"
            )
            return
        }
        do {
            try audioSession.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetoothHFP, .defaultToSpeaker]
            )
            try audioSession.setActive(true)
            isPreparing = false
            call.resolve(["route": routeSummary()])
        } catch {
            isPreparing = false
            deactivateWithoutCallback()
            call.reject(
                "The voice audio session could not be activated.",
                "AUDIO_SESSION_ACTIVATION_FAILED"
            )
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let interruptionType = AVAudioSession.InterruptionType(rawValue: rawType) else {
            return
        }
        if interruptionType == .began {
            cancelPreparation()
        }
        emit(
            type: "interruption",
            shouldDisconnect: interruptionType == .began
        )
    }

    private func handleRouteChange(_ notification: Notification) {
        let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = rawReason.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
        let routeUnavailable = reason == .oldDeviceUnavailable
        if routeUnavailable {
            cancelPreparation()
        }
        emit(
            type: routeUnavailable ? "route-unavailable" : "route-changed",
            shouldDisconnect: routeUnavailable
        )
    }

    private func emit(type: String, shouldDisconnect: Bool) {
        notifyListeners(
            "stateChanged",
            data: [
                "type": type,
                "route": routeSummary(),
                "shouldDisconnect": shouldDisconnect
            ]
        )
    }

    private func deactivateWithoutCallback() {
        cancelPreparation()
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func cancelPreparation() {
        isPreparing = false
        preparationGeneration += 1
    }

    private func routeSummary() -> String {
        let route = audioSession.currentRoute
        let inputs = Set(route.inputs.map { sanitizedPort($0.portType) }).sorted()
        let outputs = Set(route.outputs.map { sanitizedPort($0.portType) }).sorted()
        let input = inputs.isEmpty ? "none" : inputs.joined(separator: "+")
        let output = outputs.isEmpty ? "none" : outputs.joined(separator: "+")
        return "input=\(input);output=\(output)"
    }

    private func sanitizedPort(_ port: AVAudioSession.Port) -> String {
        switch port {
        case .builtInMic:
            return "built-in-mic"
        case .builtInReceiver:
            return "receiver"
        case .builtInSpeaker:
            return "speaker"
        case .headphones, .headsetMic:
            return "wired-headset"
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
            return "bluetooth"
        case .airPlay:
            return "airplay"
        case .carAudio:
            return "car-audio"
        case .HDMI:
            return "hdmi"
        case .usbAudio:
            return "usb"
        case .lineIn, .lineOut:
            return "line"
        default:
            return "other"
        }
    }
}
