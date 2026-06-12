export const selectors = {
  userId: [
    '#userId',
    '#user_id',
    '#loginId',
    '#login_id',
    'input[name="userId"]',
    'input[name="USER_ID"]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[placeholder*="User" i]'
  ],
  password: [
    '#password',
    '#pwd',
    '#passwd',
    'input[type="password"]',
    'input[name="password"]',
    'input[name*="pwd" i]',
    'input[name="PWD"]'
  ],
  sendOtp: [
    '#btnGenerateOtp',
    '#btnSendOtp',
    '#btnSendOTP',
    'button:has-text("Send OTP")',
    'input[type="button"][value*="Send OTP" i]',
    'a:has-text("Send OTP")',
    'text=Send OTP'
  ],
  otp: [
    '#otpEnter',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[placeholder*="OTP" i]'
  ],
  submit: [
    '#btnLoginClickGdmsNew',
    '#btnLogin',
    'button:has-text("Login")',
    'button:has-text("Submit")',
    'input[type="submit"]',
    'input[type="button"][value*="Login" i]',
    'input[type="button"][value*="Submit" i]'
  ],
  sessionExpiredText: [
    'text=/session expired/i',
    'text=/login again/i'
  ]
};
