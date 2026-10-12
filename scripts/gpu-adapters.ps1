Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MargoEngineAdapters {
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid id, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapter(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDescription(IntPtr self, out Description description);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint Release(IntPtr self);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Description {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Name;
    public uint Vendor, Device, Subsystem, Revision;
    public UIntPtr DedicatedVideo, DedicatedSystem, SharedSystem;
    public uint Low; public int High; public uint Flags;
  }
  static T Method<T>(IntPtr self, int slot) { return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot*IntPtr.Size), typeof(T)); }
  public static void Print() {
    Guid id=new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref id,out factory));
    try { for(uint i=0;;i++) { IntPtr adapter; int hr=Method<EnumAdapter>(factory,12)(factory,i,out adapter); if(hr==unchecked((int)0x887A0002)) break; Marshal.ThrowExceptionForHR(hr);
      try { Description d; Marshal.ThrowExceptionForHR(Method<GetDescription>(adapter,10)(adapter,out d)); Console.WriteLine(d.Name+"|"+d.Vendor.ToString("x")+"|"+d.High+","+d.Low+"|"+d.DedicatedVideo.ToUInt64()); }
      finally { Method<Release>(adapter,2)(adapter); }
    } } finally { Method<Release>(factory,2)(factory); }
  }
}
'@
[MargoEngineAdapters]::Print()
