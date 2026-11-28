// Margo GPUGraphLayout opening positions, captured after two WebGPU passes on the public pin.
export const openingPasses=2;
const packed=[
  'oLpgKR6ytyysvEYhHLxXMriuRyWex0Yi7LN8Nj+3YBrQx5g1eazJK/bC0RkHvK42drCNHzvOUSdcrEA7oLnLE5vC',
  'uDwIqAAnBsmwG0eyFj7br7kactAEOX+qbS7iwaITp8A1Qteqqx/y0YImFa7QQFO33A3L0K0+naNSLCLHhBR/uBpA',
  'iq+RGazUoilapjY/W75eDO3CyEJqp5khbc9zH5CwNkLPtfoIMNUlPWKiLC4cyFUSy71pRDWp0h1l1hQnRKZgQqC5',
  'Ogm60lpBvZ/VKoXLkBVA60A67eWRNh71ejrZ5YdEausnMZj0mkRN4tg3ufNGNZjoV0zy5P8s4fnzQS/eL0Tc7hcw',
  'AO/MRXLcnDXR94g1rOM6UXbnhSma+PpGINmyPr70GzDf5xdSg970K/n/vj4o3SNGlOzXK2b0mEyi2Y03lfqoM07i',
  'jVYL5fclzf80RqDYrkO+75csb+8iU8LdMzLhAxQ7697lUyPopCZ3+rFMRNiyPs34HDDV5VVXpN4VKD4E3T9m14lI',
  'MPAhKkAvoDjGK442yDbJO+giujnGN0Y0YTCxQ9Mi4zCfP6I7OCDsP8UxXDLPNKVAOB2LNp5CKTbUKvZJ7yQ1Lf9D',
  'F0D9G+g81jhiMOAz+UegHKkwQ0lBNwchDUXEL7ctZENOROAXXzieQo4yzS2NTw0hPy33SE5AVhgmQe80fC7nNdtI',
  'QhfhMspIJTTGHGBLYyvTK3lGQUNZFMw8vz5UL/8ydU6BF+ctA01fPCQaqEiwMaMs2UWlR/ISgDeCSpUxfCoYUKBP',
  'IBiSUrkSZVE2Io5IahBcWi0YQUg+JYdQBQ/hWAEhikRSFZhYlw8XUOoos0u3CXlcUR0jReQg8lXwCFVVEi4dRD8M',
  'L1urE5lJRi63TsgEhVwEIhFCrxxZXHEJf1XvMUxE0wj4Xpwa2UaAK2pU+QMaVlQnP0BfF5ZeyQv+SgozJ025AMRf',
  'sR1YQUIdGFiBBBdX3i8pQGQJv2ArFSRGXDAkUGwAol0fJ3U+VRoIX5EG4CTg8V0jHPgOI1HqpTH18rwcnPntJ+Ti',
  'JilG+z4ahermNr7uICBW/E8g9eNON7X4gBLM9DgvbuBnJVf+fBdR6WU5RfHgGhn63ynh3Ns3FgBtEPnuTzp26zsh',
  'VP8IHFnhYz0m+mkO//ZgMCzbuS2zAuUVg+phPEHsdhqp/GokKtqwPm7+XgqF9L80ztyjJmwBchdr4yY/Bfh8Eg78',
  'Xiib2YQxRgUgCvHwFT8o6uwbv/92HTXbkUBT+h8JH/UlNSLasSwNBmBLwMqVRSnLulDdwXlTt9MtRhfGHFkJxa1F',
  '3tPDScS891pI1Ro/vMr8VXK8WU/t2CxF0sA2YCnI2EHT1V5OjrWGWtrXkzvjx5VeksHrRuDZ0EQCux1mHM/SOYHN',
  'rlEouwRRtdmNPjvAhGLqw2c+bdr6SnOxImAp2KU3g8odW1m91k0t3EJBgbwQZBbOiDtO2iRRnLKNXHTcnDrSwoJk',
  'UcHAQZ3c50U6s25mBdWZNVjOeFV+tNpNmd2qPG29T2huxxs8j919T/auQAGgwqkE5bnRBBXJ5vbTvPkLjbv/+fTO',
  '9P8euOoJbsl57jLBOQt+tgwHtM5J8mm29hBfwH7yW8w/BFy2xQhLy9jpVrw1D/+7lvro1YL1Y7B9EwrFH+wfyGgK',
  '9LFICMjU4umXtfsX2Lq77xzSKv2esJ4O0cmP5Qa/yRAetLf/+Nm+7Guu5BdgxTzqXM2YB1Cwgw250z7lDblgHB63',
  'm/Pl1g73Ua2dFdLJDuZbxlcN67DfBWbYB+khr4gb/cBz7I3Tgvz7q+wRkc4046S++hoPtsL4nNy38N2qERvLxSDF',
  'INwPvQvU1cyq3jC8fuXnwxTRF8w/5t25d9ea08PV4L7a7da7tMqY0zfhXLIJ4Z7Ie8x0xqvrpLZb02zYMdnWthns',
  '/MJizZbTgep9smTb+9HZz+G/7/WFtjnHmtqP3giwBOyEyCLHDtKt70KvE9LP12TUzrug+F+5GMUs2azpIq3u4brL',
  'Nsknxgr4qbECyHHfR9ouswfylML3xJbVOO1arFXbudS4zpnAXvkjuFfBX95Y5hqvpeUYyzPFtMyE9b6umc9p32rU',
  'zrSP+lS79sE=',
].join('');
const bytes=Uint8Array.from(atob(packed),letter=>letter.charCodeAt(0));
const coordinates=new DataView(bytes.buffer);
export const openingPositions=new Float32Array(bytes.length*3/4);
for(let i=0;i<bytes.length/4;i++){
  openingPositions[i*3]=coordinates.getInt16(i*4,true)/3200;
  openingPositions[i*3+1]=coordinates.getInt16(i*4+2,true)/3200;
}
