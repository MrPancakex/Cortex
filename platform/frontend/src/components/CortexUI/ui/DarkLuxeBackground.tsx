import React from 'react';

export default function DarkLuxeBackground() {
  return (
    <div className="fixed inset-0 z-[-1] pointer-events-none bg-black overflow-hidden">
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+PHBhdGggZD0iTTAgMGg0MHY0MEgweiIgZmlsbD0ibm9uZSIvPjxwYXRoIGQ9Ik0wIDExLjVsMjAgMTEuNSA0MC0xMS41TTAgMjguNWwyMCAxMS41IDQwLTExLjVNMjAgMjN2MjMiIHN0cm9rZT0icmdiYSgyNTUsMjU1LDI1NSwwLjAyKSIvPjwvc3ZnPg==')] bg-center bg-repeat opacity-40"></div>
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80vw] h-[50vh] bg-cyan-900/10 blur-[120px] rounded-full"></div>
      <div className="absolute bottom-0 right-1/4 w-[60vw] h-[40vh] bg-purple-900/10 blur-[120px] rounded-full"></div>
    </div>
  );
}
