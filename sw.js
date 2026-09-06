importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js');

firebase.initializeApp({
  apiKey: 'AIzaSyB6MXuT01OqwVrglAsGGTxYHhpoc2I-QPk',
  authDomain: 'tokenonspot.firebaseapp.com',
  projectId: 'tokenonspot',
  storageBucket: 'tokenonspot.firebasestorage.app',
  messagingSenderId: '26601366564',
  appId: '1:26601366564:web:eee67486ab849ac06824b1'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification ? payload.notification.title : 'TokSpot Alert';
  const body = payload.notification ? payload.notification.body : 'Your token is called!';
  const tag = payload.data && payload.data.token ? payload.data.token : 'token';
  self.registration.showNotification(title, { body, icon: 'logo.png', badge: 'logo.png', tag });
});