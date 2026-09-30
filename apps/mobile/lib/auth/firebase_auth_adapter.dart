import 'dart:async';

import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';

import '../config/env.dart';
import 'auth_adapter.dart';

/// Firebase Auth telefon OTP + App Check (ADR-0025). Token kalıcılığı Firebase SDK'sındadır;
/// uygulama kendi sırrını saklamaz.
class FirebaseAuthAdapter implements AuthAdapter {
  FirebaseAuthAdapter._(this._auth, this._appCheck);

  final FirebaseAuth _auth;
  final FirebaseAppCheck _appCheck;

  static Future<FirebaseAuthAdapter> initialize(FirebaseEnv env) async {
    final app = await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: env.apiKey,
        appId: env.appId,
        projectId: env.projectId,
        messagingSenderId: env.messagingSenderId,
      ),
    );
    final appCheck = FirebaseAppCheck.instanceFor(app: app);
    // Debug sağlayıcısı yalnız debug build'de; release'de Play Integrity / App Attest.
    await appCheck.activate(
      providerAndroid: kDebugMode
          ? const AndroidDebugProvider()
          : const AndroidPlayIntegrityProvider(),
      providerApple: kDebugMode
          ? const AppleDebugProvider()
          : const AppleAppAttestWithDeviceCheckFallbackProvider(),
    );
    return FirebaseAuthAdapter._(FirebaseAuth.instanceFor(app: app), appCheck);
  }

  @override
  Stream<bool> get signedInChanges =>
      _auth.idTokenChanges().map((user) => user != null);

  @override
  bool get isSignedIn => _auth.currentUser != null;

  @override
  Future<String?> idToken() async => _auth.currentUser?.getIdToken();

  @override
  Future<String?> appCheckToken() => _appCheck.getToken();

  @override
  Future<void> signOut() => _auth.signOut();

  /// OTP gönderir; kod gelince [onCodeSent] doğrulama kimliğini verir. Android otomatik
  /// doğrulamada oturum doğrudan açılır.
  Future<void> sendCode(
    String phoneE164, {
    required void Function(String verificationId) onCodeSent,
    required void Function(FirebaseAuthException error) onError,
  }) {
    return _auth.verifyPhoneNumber(
      phoneNumber: phoneE164,
      verificationCompleted: (credential) =>
          _auth.signInWithCredential(credential),
      verificationFailed: onError,
      codeSent: (verificationId, _) => onCodeSent(verificationId),
      codeAutoRetrievalTimeout: (_) {},
    );
  }

  Future<void> confirmCode(String verificationId, String code) async {
    await _auth.signInWithCredential(
      PhoneAuthProvider.credential(
        verificationId: verificationId,
        smsCode: code,
      ),
    );
  }
}
