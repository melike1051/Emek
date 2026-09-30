import 'package:firebase_auth/firebase_auth.dart' show FirebaseAuthException;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/auth_adapter.dart';
import '../../auth/firebase_auth_adapter.dart';
import '../../auth/phone.dart';
import '../../session/providers.dart';
import '../../widgets/error_view.dart';

/// Giriş: telefon OTP (Firebase) ya da yerel geliştirici girişi (mock). Oturum kurulunca
/// yönlendirmeyi router yapar.
class LoginScreen extends ConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authAdapterProvider);
    final signedIn = ref.watch(signedInProvider).value ?? false;
    final session = ref.watch(sessionProvider);

    final Widget body;
    if (signedIn && session.hasError) {
      body = ErrorView(
        title: 'Oturum açılamadı',
        error: session.error!,
        onRetry: () => ref.invalidate(sessionProvider),
      );
    } else if (signedIn) {
      body = const Center(child: CircularProgressIndicator());
    } else if (auth is MockAuthAdapter) {
      body = _MockLoginForm(adapter: auth);
    } else if (auth is FirebaseAuthAdapter) {
      body = _PhoneLoginForm(adapter: auth);
    } else {
      body = const SizedBox.shrink();
    }

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 32),
            Text(
              "Emek'e hoş geldiniz",
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 8),
            const Text('Cep telefonunuza gelecek kodla güvenle giriş yapın.'),
            const SizedBox(height: 32),
            body,
          ],
        ),
      ),
    );
  }
}

class _MockLoginForm extends StatefulWidget {
  const _MockLoginForm({required this.adapter});

  final MockAuthAdapter adapter;

  @override
  State<_MockLoginForm> createState() => _MockLoginFormState();
}

class _MockLoginFormState extends State<_MockLoginForm> {
  final _subject = TextEditingController(text: 'dev-customer');
  final _phone = TextEditingController();
  String? _subjectError;
  String? _phoneError;

  @override
  void dispose() {
    _subject.dispose();
    _phone.dispose();
    super.dispose();
  }

  void _submit() {
    // Backend hesap oluştururken iletişim bilgisi ister (AUTH_CONTACT_REQUIRED).
    final phone = normalizeTrPhone(_phone.text);
    setState(() {
      _subjectError = null;
      _phoneError = phone == null
          ? 'Geçerli bir cep telefonu girin (ör. 0532 111 22 33).'
          : null;
    });
    if (phone == null) return;
    try {
      widget.adapter.signIn(_subject.text, phone);
    } on FormatException catch (error) {
      setState(() => _subjectError = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Geliştirici girişi — yalnızca yerel ortamda (backend AUTH_PROVIDER=mock). '
          'Aynı kimlik her seferinde aynı kullanıcıyı açar.',
        ),
        const SizedBox(height: 16),
        TextField(
          key: const Key('login.subject'),
          controller: _subject,
          decoration: InputDecoration(
            labelText: 'Geliştirici kimliği',
            errorText: _subjectError,
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('login.phone'),
          controller: _phone,
          keyboardType: TextInputType.phone,
          decoration: InputDecoration(
            labelText: 'Cep telefonu',
            hintText: '0532 111 22 33',
            errorText: _phoneError,
          ),
        ),
        const SizedBox(height: 20),
        FilledButton(onPressed: _submit, child: const Text('Giriş yap')),
      ],
    );
  }
}

class _PhoneLoginForm extends StatefulWidget {
  const _PhoneLoginForm({required this.adapter});

  final FirebaseAuthAdapter adapter;

  @override
  State<_PhoneLoginForm> createState() => _PhoneLoginFormState();
}

class _PhoneLoginFormState extends State<_PhoneLoginForm> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  String? _verificationId;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _sendCode() async {
    final phone = normalizeTrPhone(_phone.text);
    if (phone == null) {
      setState(
        () => _error = 'Geçerli bir cep telefonu girin (ör. 0532 111 22 33).',
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    await widget.adapter.sendCode(
      phone,
      onCodeSent: (id) => setState(() {
        _verificationId = id;
        _busy = false;
      }),
      onError: (error) => setState(() {
        _error = firebaseAuthMessage(error.code);
        _busy = false;
      }),
    );
  }

  Future<void> _confirm() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.adapter.confirmCode(_verificationId!, _code.text.trim());
    } on FirebaseAuthException catch (error) {
      setState(() {
        _error = firebaseAuthMessage(error.code);
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final awaitingCode = _verificationId != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!awaitingCode)
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            autofillHints: const [AutofillHints.telephoneNumberNational],
            decoration: InputDecoration(
              labelText: 'Cep telefonu',
              hintText: '0532 111 22 33',
              errorText: _error,
            ),
          )
        else
          TextField(
            controller: _code,
            keyboardType: TextInputType.number,
            autofillHints: const [AutofillHints.oneTimeCode],
            maxLength: 6,
            decoration: InputDecoration(
              labelText: 'Doğrulama kodu',
              helperText: 'Telefonunuza gelen 6 haneli kod',
              errorText: _error,
            ),
          ),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : (awaitingCode ? _confirm : _sendCode),
          child: _busy
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(),
                )
              : Text(awaitingCode ? 'Giriş yap' : 'Kod gönder'),
        ),
        if (awaitingCode)
          TextButton(
            onPressed: _busy
                ? null
                : () => setState(() => _verificationId = null),
            child: const Text('Numarayı değiştir'),
          ),
      ],
    );
  }
}
